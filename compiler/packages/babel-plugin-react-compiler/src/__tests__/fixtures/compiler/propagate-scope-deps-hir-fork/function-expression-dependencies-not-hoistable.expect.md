
## Input

```javascript
// @enablePropagateDepsInHIR

import {makeArray, identity, useIdentity} from 'shared-runtime';

function useFoo(a) {
  const fn = () => a.b.c;
  useIdentity();
  const x = makeArray();
  x.push(identity(a?.b.c));
  return [fn, x];
}

export const FIXTURE_ENTRYPOINT = {
  fn: useFoo,
  params: [null],
  sequentialRenders: [null, {b: {c: 4}}],
};

```

## Code

```javascript
import { c as _c } from "react/compiler-runtime"; // @enablePropagateDepsInHIR

import { makeArray, identity, useIdentity } from "shared-runtime";

function useFoo(a) {
  const $ = _c(7);
  let t0;
  if ($[0] !== a) {
    t0 = () => a.b.c;
    $[0] = a;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  const fn = t0;
  useIdentity();
  let x;
  if ($[2] !== a?.b.c) {
    x = makeArray();
    x.push(identity(a?.b.c));
    $[2] = a?.b.c;
    $[3] = x;
  } else {
    x = $[3];
  }
  let t1;
  if ($[4] !== fn || $[5] !== x) {
    t1 = [fn, x];
    $[4] = fn;
    $[5] = x;
    $[6] = t1;
  } else {
    t1 = $[6];
  }
  return t1;
}

export const FIXTURE_ENTRYPOINT = {
  fn: useFoo,
  params: [null],
  sequentialRenders: [null, { b: { c: 4 } }],
};

```
      
### Eval output
(kind: ok) ["[[ function params=0 ]]",[null]]
["[[ function params=0 ]]",[4]]