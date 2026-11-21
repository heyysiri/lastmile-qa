import { it, expect } from 'vitest';
import { classifyOutcome } from '../apps/runner/src/outcome';
const pass = [{id:'saved',status:'passed' as const}];
const fail = [{id:'saved',status:'failed' as const,expected:'ready',actual:null}];
it('independent checks pass only after a completed exploration or compatible replay',()=>{
 expect(classifyOutcome(pass,true)).toBe('passed');
 expect(classifyOutcome(pass,false)).toBe('inconclusive');
 expect(classifyOutcome([],true)).toBe('inconclusive');
});
it('failed evidence remains inconclusive when execution or readback is unavailable',()=>{
 expect(classifyOutcome(fail,true)).toBe('failed');
 expect(classifyOutcome(fail,false)).toBe('inconclusive');
 expect(classifyOutcome([...fail,{id:'state',status:'not_evaluated'}],true)).toBe('inconclusive');
});
