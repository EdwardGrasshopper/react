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
