import {expect,it} from 'vitest';
import {selectBrowserWorkspace} from '../apps/lastmile/lib/workspace-storage';
function memoryStorage():Storage{
 const values=new Map<string,string>();return {get length(){return values.size;},clear(){values.clear();},key(index){return [...values.keys()][index]??null;},getItem(key){return values.get(key)??null;},setItem(key,value){values.set(key,value);},removeItem(key){values.delete(key);}};
}
it('removes the previous account pending writes before restoring a new workspace',()=>{
 const storage=memoryStorage();storage.setItem('lastmile-workspace-owner','user_alice');storage.setItem('lastmile-pending-github-connection','private-request');storage.setItem('lastmile-verify-fix','private-patch');storage.setItem('unrelated','keep');
 selectBrowserWorkspace(storage,'user_bob');expect(storage.getItem('lastmile-pending-github-connection')).toBeNull();expect(storage.getItem('lastmile-verify-fix')).toBeNull();expect(storage.getItem('lastmile-workspace-owner')).toBe('user_bob');expect(storage.getItem('unrelated')).toBe('keep');
 storage.setItem('lastmile-pending-github-connection','bobs-request');selectBrowserWorkspace(storage,'user_bob');expect(storage.getItem('lastmile-pending-github-connection')).toBe('bobs-request');
});
