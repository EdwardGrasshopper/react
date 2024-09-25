import {CompilerError} from '../CompilerError';
import {inRange} from '../ReactiveScopes/InferReactiveScopeVariables';
import {
  Set_equal,
  Set_filter,
  Set_intersect,
  Set_union,
  getOrInsertDefault,
} from '../Utils/utils';
import {
  BasicBlock,
  BlockId,
  DependencyPathEntry,
  FunctionExpression,
  GeneratedSource,
  HIRFunction,
  Identifier,
  IdentifierId,
  InstructionId,
  ReactiveScopeDependency,
  ScopeId,
} from './HIR';
import {
  eachInstructionOperand,
  eachInstructionValueLValue,
  eachInstructionValueOperand,
} from './visitors';

/**
 * Helper function for `PropagateScopeDependencies`.
 * Uses control flow graph analysis to determine which `Identifier`s can
 * be assumed to be non-null objects, on a per-block basis.
 *
 * Here is an example:
 * ```js
 * function useFoo(x, y, z) {
 *   // NOT safe to hoist PropertyLoads here
 *   if (...) {
 *     // safe to hoist loads from x
 *     read(x.a);
 *     return;
 *   }
 *   // safe to hoist loads from y, z
 *   read(y.b);
 *   if (...) {
 *     // safe to hoist loads from y, z
 *     read(z.a);
 *   } else {
 *     // safe to hoist loads from y, z
 *     read(z.b);
 *   }
 *   // safe to hoist loads from y, z
 *   return;
 * }
 * ```
 *
 * Note that we currently do NOT account for mutable / declaration range
 * when doing the CFG-based traversal, producing results that are technically
 * incorrect but filtered by PropagateScopeDeps (which only takes dependencies
 * on constructed value -- i.e. a scope's dependencies must have mutable ranges
 * ending earlier than the scope start).
 *
 * Take this example, this function will infer x.foo.bar as non-nullable for bb0,
 * via the intersection of bb1 & bb2 which in turn comes from bb3. This is technically
 * incorrect bb0 is before / during x's mutable range.
 *  bb0:
 *    const x = ...;
 *    if cond then bb1 else bb2
 *  bb1:
 *    ...
 *    goto bb3
 *  bb2:
 *    ...
 *    goto bb3:
 *  bb3:
 *    x.foo.bar
 */
export function collectHoistablePropertyLoads(
  fn: HIRFunction,
  temporaries: ReadonlyMap<IdentifierId, ReactiveScopeDependency>,
  optionals: ReadonlyMap<BlockId, ReactiveScopeDependency>,
): ReadonlyMap<ScopeId, BlockInfo> {
  const tree = new Tree();

  const functionExpressionReferences = collectFunctionExpressionRValues(fn);
  const realTemporaries = new Map(temporaries);
  for (const reference of functionExpressionReferences) {
    realTemporaries.delete(reference);
  }
  const nodes = collectNonNullsInBlocks(fn, realTemporaries, optionals, tree);
  propagateNonNull(fn, nodes, tree);

  const nodesKeyedByScopeId = new Map<ScopeId, BlockInfo>();
  for (const [_, block] of fn.body.blocks) {
    if (block.terminal.kind === 'scope') {
      nodesKeyedByScopeId.set(
        block.terminal.scope.id,
        nodes.get(block.terminal.block)!,
      );
    }
  }

  return nodesKeyedByScopeId;
}

export type BlockInfo = {
  block: BasicBlock;
  assumedNonNullObjects: ReadonlySet<PropertyLoadNode>;
};

/**
 * Tree data structure to dedupe property loads (e.g. a.b.c)
 * and make computing sets intersections simpler.
 */
type RootNode = {
  properties: Map<string, PropertyLoadNode>;
  optionalProperties: Map<string, PropertyLoadNode>;
  parent: null;
  // Recorded to make later computations simpler
  fullPath: ReactiveScopeDependency;
  hasOptional: boolean;
  root: IdentifierId;
};

type PropertyLoadNode =
  | {
      properties: Map<string, PropertyLoadNode>;
      optionalProperties: Map<string, PropertyLoadNode>;
      parent: PropertyLoadNode;
      fullPath: ReactiveScopeDependency;
      hasOptional: boolean;
    }
  | RootNode;

class Tree {
  roots: Map<IdentifierId, RootNode> = new Map();

  getOrCreateIdentifier(identifier: Identifier): PropertyLoadNode {
    /**
     * Reads from a statically scoped variable are always safe in JS,
     * with the exception of TDZ (not addressed by this pass).
     */
    let rootNode = this.roots.get(identifier.id);

    if (rootNode === undefined) {
      rootNode = {
        root: identifier.id,
        properties: new Map(),
        optionalProperties: new Map(),
        fullPath: {
          identifier,
          path: [],
        },
        hasOptional: false,
        parent: null,
      };
      this.roots.set(identifier.id, rootNode);
    }
    return rootNode;
  }

  static getOrCreatePropertyEntry(
    parent: PropertyLoadNode,
    entry: DependencyPathEntry,
  ): PropertyLoadNode {
    const map = entry.optional ? parent.optionalProperties : parent.properties;
    let child = map.get(entry.property);
    if (child == null) {
      child = {
        properties: new Map(),
        optionalProperties: new Map(),
        parent: parent,
        fullPath: {
          identifier: parent.fullPath.identifier,
          path: parent.fullPath.path.concat(entry),
        },
        hasOptional: parent.hasOptional || entry.optional,
      };
      map.set(entry.property, child);
    }
    return child;
  }

  getOrCreateProperty(n: ReactiveScopeDependency): PropertyLoadNode {
    /**
     * We add ReactiveScopeDependencies according to instruction ordering,
     * so all subpaths of a PropertyLoad should already exist
     * (e.g. a.b is added before a.b.c),
     */
    let currNode = this.getOrCreateIdentifier(n.identifier);
    if (n.path.length === 0) {
      return currNode;
    }
    for (let i = 0; i < n.path.length - 1; i++) {
      currNode = Tree.getOrCreatePropertyEntry(currNode, n.path[i]);
    }

    return Tree.getOrCreatePropertyEntry(currNode, n.path.at(-1)!);
  }
}

function pushPropertyLoadNode(
  node: PropertyLoadNode,
  instrId: InstructionId,
  knownImmutableIdentifiers: Set<IdentifierId>,
  result: Set<PropertyLoadNode>,
): void {
  const object = node.fullPath.identifier;
  /**
   * Since this runs *after* buildReactiveScopeTerminals, identifier mutable ranges
   * are not valid with respect to current instruction id numbering.
   * We use attached reactive scope ranges as a proxy for mutable range, but this
   * is an overestimate as (1) scope ranges merge and align to form valid program
   * blocks and (2) passes like MemoizeFbtAndMacroOperands may assign scopes to
   * non-mutable identifiers.
   *
   * See comment at top of function for why we track known immutable identifiers.
   */
  const isMutableAtInstr =
    object.mutableRange.end > object.mutableRange.start + 1 &&
    object.scope != null &&
    inRange({id: instrId}, object.scope.range);
  if (
    !isMutableAtInstr ||
    knownImmutableIdentifiers.has(node.fullPath.identifier.id)
  ) {
    result.add(node);
  }
}

function collectNonNullsInBlocks(
  fn: HIRFunction,
  temporaries: ReadonlyMap<IdentifierId, ReactiveScopeDependency>,
  optionals: ReadonlyMap<BlockId, ReactiveScopeDependency>,
  tree: Tree,
): ReadonlyMap<BlockId, BlockInfo> {
  /**
   * Due to current limitations of mutable range inference, there are edge cases in
   * which we infer known-immutable values (e.g. props or hook params) to have a
   * mutable range and scope.
   * (see `destructure-array-declaration-to-context-var` fixture)
   * We track known immutable identifiers to reduce regressions (as PropagateScopeDeps
   * is being rewritten to HIR).
   */
  const knownImmutableIdentifiers = new Set<IdentifierId>();
  if (fn.fnType === 'Component' || fn.fnType === 'Hook') {
    for (const p of fn.params) {
      if (p.kind === 'Identifier') {
        knownImmutableIdentifiers.add(p.identifier.id);
      }
    }
  }
  /**
   * Known non-null objects such as functional component props can be safely
   * read from any block.
   */
  const knownNonNullIdentifiers = new Set<PropertyLoadNode>();
  if (
    fn.env.config.enablePropagateDepsInHIR === 'enabled_with_optimizations' &&
    fn.fnType === 'Component' &&
    fn.params.length > 0 &&
    fn.params[0].kind === 'Identifier'
  ) {
    const identifier = fn.params[0].identifier;
    knownNonNullIdentifiers.add(tree.getOrCreateIdentifier(identifier));
  }
  const nodes = new Map<BlockId, BlockInfo>();
  for (const [_, block] of fn.body.blocks) {
    const assumedNonNullObjects = new Set<PropertyLoadNode>(
      knownNonNullIdentifiers,
    );

    nodes.set(block.id, {
      block,
      assumedNonNullObjects,
    });
    const maybeOptionalChain = optionals.get(block.id);
    if (maybeOptionalChain != null) {
      assumedNonNullObjects.add(tree.getOrCreateProperty(maybeOptionalChain));
      continue;
    }
    for (const instr of block.instructions) {
      if (instr.value.kind === 'PropertyLoad') {
        const source = temporaries.get(instr.value.object.identifier.id) ?? {
          identifier: instr.value.object.identifier,
          path: [],
        };
        const propertyNode = tree.getOrCreateProperty(source);
        pushPropertyLoadNode(
          propertyNode,
          instr.id,
          knownImmutableIdentifiers,
          assumedNonNullObjects,
        );
      } else if (
        instr.value.kind === 'Destructure' &&
        fn.env.config.enablePropagateDepsInHIR === 'enabled_with_optimizations'
      ) {
        const source = instr.value.value.identifier.id;
        const sourceNode = temporaries.get(source);
        if (sourceNode != null) {
          pushPropertyLoadNode(
            tree.getOrCreateProperty(sourceNode),
            instr.id,
            knownImmutableIdentifiers,
            assumedNonNullObjects,
          );
        }
      } else if (
        instr.value.kind === 'ComputedLoad' &&
        fn.env.config.enablePropagateDepsInHIR === 'enabled_with_optimizations'
      ) {
        const source = instr.value.object.identifier.id;
        const sourceNode = temporaries.get(source);
        if (sourceNode != null) {
          pushPropertyLoadNode(
            tree.getOrCreateProperty(sourceNode),
            instr.id,
            knownImmutableIdentifiers,
            assumedNonNullObjects,
          );
        }
      }
    }
  }
  return nodes;
}

function propagateNonNull(
  fn: HIRFunction,
  nodes: ReadonlyMap<BlockId, BlockInfo>,
  tree: Tree,
): void {
  const blockSuccessors = new Map<BlockId, Set<BlockId>>();
  const terminalPreds = new Set<BlockId>();

  for (const [blockId, block] of fn.body.blocks) {
    for (const pred of block.preds) {
      getOrInsertDefault(blockSuccessors, pred, new Set()).add(blockId);
    }
    if (block.terminal.kind === 'throw' || block.terminal.kind === 'return') {
      terminalPreds.add(blockId);
    }
  }

  /**
   * In the context of a control flow graph, the identifiers that a block
   * can assume are non-null can be calculated from the following:
   * X = Union(Intersect(X_neighbors), X)
   */
  function recursivelyPropagateNonNull(
    nodeId: BlockId,
    direction: 'forward' | 'backward',
    traversalState: Map<BlockId, 'active' | 'done'>,
  ): boolean {
    /**
     * Avoid re-visiting computed or currently active nodes, which can
     * occur when the control flow graph has backedges.
     */
    if (traversalState.has(nodeId)) {
      return false;
    }
    traversalState.set(nodeId, 'active');

    const node = nodes.get(nodeId);
    if (node == null) {
      CompilerError.invariant(false, {
        reason: `Bad node ${nodeId}, kind: ${direction}`,
        loc: GeneratedSource,
      });
    }
    const neighbors = Array.from(
      direction === 'backward'
        ? (blockSuccessors.get(nodeId) ?? [])
        : node.block.preds,
    );

    let changed = false;
    for (const pred of neighbors) {
      if (!traversalState.has(pred)) {
        const neighborChanged = recursivelyPropagateNonNull(
          pred,
          direction,
          traversalState,
        );
        changed ||= neighborChanged;
      }
    }
    /**
     * Note that a predecessor / successor can only be active (status != 'done')
     * if it is a self-loop or other transitive cycle. Active neighbors can be
     * filtered out (i.e. not included in the intersection)
     * Example: self loop.
     *    X = Union(Intersect(X, ...X_other_neighbors), X)
     *
     * Example: transitive cycle through node Y, for some Y that is a
     * predecessor / successor of X.
     *    X = Union(
     *          Intersect(
     *            Union(Intersect(X, ...Y_other_neighbors), Y),
     *            ...X_neighbors
     *          ),
     *          X
     *        )
     *
     * Non-active neighbors with no recorded results can occur due to backedges.
     * it's not safe to assume they can be filtered out (e.g. not included in
     * the intersection)
     */
    const neighborAccesses = Set_intersect(
      Array.from(neighbors)
        .filter(n => traversalState.get(n) === 'done')
        .map(n => assertNonNull(nodes.get(n)).assumedNonNullObjects),
    );

    const prevObjects = assertNonNull(nodes.get(nodeId)).assumedNonNullObjects;
    const mergedObjects = Set_union(prevObjects, neighborAccesses);
    reduceMaybeOptionalChains(mergedObjects, tree);

    assertNonNull(nodes.get(nodeId)).assumedNonNullObjects = mergedObjects;
    traversalState.set(nodeId, 'done');
    /**
     * Note that it might not sufficient to compare set sizes since reduceMaybeOptionalChains
     * may replace optional-chain loads with unconditional loads
     */
    changed ||= !Set_equal(prevObjects, mergedObjects);
    return changed;
  }
  const traversalState = new Map<BlockId, 'done' | 'active'>();
  const reversedBlocks = [...fn.body.blocks];
  reversedBlocks.reverse();

  let changed;
  let i = 0;
  do {
    CompilerError.invariant(i++ < 100, {
      reason:
        '[CollectHoistablePropertyLoads] fixed point iteration did not terminate after 100 loops',
      loc: GeneratedSource,
    });

    changed = false;
    for (const [blockId] of fn.body.blocks) {
      const forwardChanged = recursivelyPropagateNonNull(
        blockId,
        'forward',
        traversalState,
      );
      changed ||= forwardChanged;
    }
    traversalState.clear();
    for (const [blockId] of reversedBlocks) {
      const backwardChanged = recursivelyPropagateNonNull(
        blockId,
        'backward',
        traversalState,
      );
      changed ||= backwardChanged;
    }
    traversalState.clear();
  } while (changed);
}

export function assertNonNull<T extends NonNullable<U>, U>(
  value: T | null | undefined,
  source?: string,
): T {
  CompilerError.invariant(value != null, {
    reason: 'Unexpected null',
    description: source != null ? `(from ${source})` : null,
    loc: GeneratedSource,
  });
  return value;
}

/**
 * Any two optional chains with different operations . vs ?. but the same set of
 * property strings paths de-duplicates.
 *
 * Intuitively: given <base>?.b, we know <base> to be either hoistable or not.
 * If <base> is hoistable, we can replace all <base>?.PROPERTY_STRING subpaths
 * with <base>.PROPERTY_STRING
 */
function reduceMaybeOptionalChains(
  nodes: Set<PropertyLoadNode>,
  tree: Tree,
): void {
  let optionalChainNodes = Set_filter(nodes, n => n.hasOptional);
  if (optionalChainNodes.size === 0) {
    return;
  }
  const knownNonNulls = new Set(nodes);
  let changed: boolean;
  do {
    changed = false;

    for (const original of optionalChainNodes) {
      let {identifier, path: origPath} = original.fullPath;
      let currNode: PropertyLoadNode = tree.getOrCreateIdentifier(identifier);
      for (let i = 0; i < origPath.length; i++) {
        const entry = origPath[i];
        // If the base is known to be non-null, replace with a non-optional load
        const nextEntry: DependencyPathEntry =
          entry.optional && knownNonNulls.has(currNode)
            ? {property: entry.property, optional: false}
            : entry;
        currNode = Tree.getOrCreatePropertyEntry(currNode, nextEntry);
      }
      if (currNode !== original) {
        changed = true;
        optionalChainNodes.delete(original);
        optionalChainNodes.add(currNode);
        nodes.delete(original);
        nodes.add(currNode);
        knownNonNulls.add(currNode);
      }
    }
  } while (changed);
}

function collectFunctionExpressionRValues(fn: HIRFunction): Set<IdentifierId> {
  const uses = new Map<IdentifierId, Set<IdentifierId>>();
  const functionExpressionReferences = new Set<IdentifierId>();

  for (const [_, block] of fn.body.blocks) {
    for (const {lvalue, value} of block.instructions) {
      if (value.kind === 'FunctionExpression') {
        for (const reference of value.loweredFunc.dependencies) {
          const queued = [reference.identifier.id];
          while (queued.length > 0) {
            const top = queued.pop()!;
            functionExpressionReferences.add(top);
            for (const reference of uses.get(top) ?? []) {
              queued.push(reference);
            }
          }
        }
      } else {
        const operands = [
          ...eachInstructionValueOperand(value),
          ...eachInstructionValueLValue(value),
        ];
        if (!operands.every(operand => operand.identifier.name == null)) {
          continue;
        }
        uses.set(
          lvalue.identifier.id,
          new Set(operands.map(operand => operand.identifier.id)),
        );
      }
    }
  }
  return functionExpressionReferences;
}
