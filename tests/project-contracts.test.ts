import {expect,it} from 'vitest';
import {ConnectProjectSchema,ProjectCheckSchema,ProjectPlanSchema} from '../packages/contracts/src/projects';
it('accepts a development repository without a registered application or workflow',()=>{expect(ConnectProjectSchema.parse({requestId:'connect',name:'My app',repositoryPath:'/work/my-app',appUrl:'http://127.0.0.1:9005/dashboard',brief:'Test returning marketplace staff'})).toMatchObject({accounts:[],requirements:''});});
it('rejects credentials in URLs and out-of-root command paths',()=>{const base={requestId:'connect',name:'My app',repositoryPath:'/work/app',appUrl:'http://user:pass@localhost',brief:'Test marketplace staff'};expect(ConnectProjectSchema.safeParse(base).success).toBe(false);expect(ConnectProjectSchema.safeParse({...base,appUrl:'http://localhost',commands:{start:['pnpm','dev'],cwd:'../private'}}).success).toBe(false);});
it.each([{appUrl:'invalid URL'},{appUrl:'http://localhost',allowedOrigins:['http://[invalid]']}])('returns validation issues for malformed project URLs',urls=>{
 const result=ConnectProjectSchema.safeParse({requestId:'connect',name:'My app',repositoryPath:'/work/app',brief:'Test marketplace staff',...urls});
 expect(result.success).toBe(false);
});
it('requires a readback location for preserved state and provenance for every check',()=>{const check={id:'stock',label:'Preserve stock',kind:'field',phase:'preserve',locator:{by:'label',value:'Stock'},basis:'requirement',sources:[]};expect(ProjectCheckSchema.safeParse(check).success).toBe(false);});
it('does not accept an empty generated testing plan',()=>{expect(ProjectPlanSchema.safeParse({summary:'An app',features:[],roles:[],testers:[],journeys:[],gaps:[]}).success).toBe(false);});
