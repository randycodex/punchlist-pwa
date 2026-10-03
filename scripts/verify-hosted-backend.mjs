import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
// Destructive disposable-project acceptance harness. Never target live data.
import { validateHostedAcceptanceTarget, boundedAcceptanceFetch } from './lib/hostedAcceptance.mjs';
const {base,keysFile}=validateHostedAcceptanceTarget(process.env);
const keys=JSON.parse(fs.readFileSync(keysFile));
const anon=keys.find(x=>x.name==='anon')?.api_key, service=keys.find(x=>x.name==='service_role')?.api_key;
assert(anon && service, 'Existing private keys file must contain anon and service_role entries.');
const results=[];
async function req(path,token,body,method='POST',headers={}) {
 const r=await boundedAcceptanceFetch(base+path,{method,headers:{apikey:anon,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 const text=r.text;let data;try{data=JSON.parse(text)}catch{data=text};return {status:r.status,data};
}
function pass(name){results.push(name);console.log('PASS',name);}
function ok(r){assert(r.status>=200&&r.status<300,`Hosted acceptance failed: HTTP ${r.status}, code ${r.data?.code ?? 'unknown'}`);return r.data;}
function deny(r){assert(r.status>=400&&r.status<500,`Expected deliberate denial, got HTTP ${r.status}`);}
const rpc=(name,token,args)=>req('/rest/v1/rpc/'+name,token,args);
async function user(label){const email=`staging-${label}-${randomUUID()}@uai-ny.com`,password=randomUUID()+'Aa!';ok(await req('/auth/v1/admin/users',service,{email,password,email_confirm:true}));const login=ok(await req('/auth/v1/token?grant_type=password',anon,{email,password}));return {email,token:login.access_token,id:login.user.id};}
const owner=await user('owner'), member=await user('member'), outsider=await user('outsider');pass('Disposable confirmed accounts authenticate without sending email');
const local=randomUUID(),area=randomUUID(),phone=randomUUID(),computer=randomUUID();
const project=ok(await rpc('create_shared_project',owner.token,{p_local_project_id:local,p_project_name:'Staging verification',p_owner_email:owner.email}));
const payload={id:local,projectName:'Staging verification',areas:[{id:area,locations:[]}]};
let r=await rpc('publish_shared_project_snapshot_v2',owner.token,{p_project_id:project,p_project_payload:payload,p_payload_version:1,p_base_metadata_version:0,p_base_published_at:null});ok(r);pass('Create project and publish initial snapshot through PostgREST');
const backupArgs={p_project_id:project,p_device_recovery_id:randomUUID(),p_project_payload:payload,p_payload_version:1,p_reason:'manual',p_note:'Synthetic acceptance retry'};
const backupId=ok(await rpc('capture_shared_project_device_backup',owner.token,backupArgs));
assert.equal(ok(await rpc('capture_shared_project_device_backup',owner.token,backupArgs)),backupId);
const backupRows=ok(await req(`/rest/v1/shared_project_snapshot_history?project_id=eq.${project}&device_recovery_id=eq.${backupArgs.p_device_recovery_id}&select=id`,owner.token,undefined,'GET'));
assert.deepEqual(backupRows,[{id:backupId}]);pass('Idempotent backup retry returns exactly one history ID');
const join=ok(await rpc('generate_shared_project_join_code',owner.token,{p_project_id:project}));ok(await rpc('join_shared_project_by_code',member.token,{p_join_code:join.join_code,p_member_email:member.email}));pass('Second account joins disposable project');
const claimArgs={p_project_id:project,p_area_id:area,p_device_id:phone};const claim=ok(await rpc('claim_shared_project_area_v2',member.token,claimArgs));assert.equal(ok(await rpc('claim_shared_project_area_v2',member.token,claimArgs)).id,claim.id);pass('Phone claim retries retain claim identity');
deny(await rpc('claim_shared_project_area_v2',member.token,{...claimArgs,p_device_id:computer}));pass('Same-account computer cannot take phone lock');
const release={p_project_id:project,p_area_id:area,p_claim_id:claim.id,p_device_id:phone,p_expected_version:0};deny(await rpc('release_shared_project_area_v2',member.token,{...release,p_device_id:computer}));pass('Same-account computer cannot release phone lock');
deny(await rpc('release_shared_project_area',member.token,{p_project_id:project,p_area_id:area}));pass('Legacy release RPC cannot bypass device guard');
const publish={p_project_id:project,p_area_id:area,p_area_payload:payload,p_payload_version:1,p_base_version:0,p_client_id:randomUUID(),p_device_id:phone};
deny(await rpc('publish_shared_project_area_snapshot',member.token,{...publish,p_device_id:computer}));pass('Wrong device cannot publish');
const published=ok(await rpc('publish_shared_project_area_snapshot',member.token,publish));const version=published[0].area_version;assert.equal(ok(await rpc('publish_shared_project_area_snapshot',member.token,publish))[0].area_version,version);pass('Area publication and idempotent retry accepted');
assert.equal((await rpc('release_shared_project_area_v2',member.token,release)).status,409);pass('Stale release version returns HTTP 409');
ok(await rpc('release_shared_project_area_v2',member.token,{...release,p_expected_version:version}));ok(await rpc('release_shared_project_area_v2',member.token,{...release,p_expected_version:version}));pass('Accepted-version release and retry succeed');
const nextClaim=ok(await rpc('claim_shared_project_area_v2',member.token,{...claimArgs,p_device_id:computer}));ok(await rpc('release_shared_project_area_v2',member.token,{...release,p_expected_version:version}));const claims=ok(await req(`/rest/v1/area_claims?id=eq.${nextClaim.id}&select=status`,member.token,undefined,'GET'));assert.equal(claims[0].status,'active');pass('Old release retry preserves replacement claim');
for(const [table,body] of Object.entries({shared_projects:{owner_user_id:member.id},project_members:{access_state:'removed'},area_claims:{status:'released'},shared_project_snapshots:{payload_version:99}})) { const attempt=await req(`/rest/v1/${table}?${table==='shared_projects'?'id':'project_id'}=eq.${project}`,member.token,body,'PATCH'); assert.equal(attempt.data.code,'42501',JSON.stringify(attempt)); }pass('Direct collaboration table mutations denied');
assert.deepEqual(ok(await req('/rest/v1/shared_projects?select=id',outsider.token,undefined,'GET')),[]);deny(await rpc('claim_shared_project_area_v2',outsider.token,claimArgs));deny(await rpc('claim_shared_project_area_v2',anon,claimArgs));pass('Outsider and anonymous requests cannot access project');
ok(await rpc('release_abandoned_shared_project_area',owner.token,{p_project_id:project,p_area_id:area,p_claim_id:nextClaim.id}));pass('Owner recovers abandoned device claim');
const photoBytes='test-photo';
const photoHash=createHash('sha256').update(photoBytes).digest('hex');
const path=`${project}/${randomUUID()}/${photoHash}-photo.jpg`,url=base+'/storage/v1/object/punchlist-attachments/'+path;
async function object(method,token,bytes='test-photo',extra={}){const r=await boundedAcceptanceFetch(url,{method,headers:{apikey:anon,Authorization:`Bearer ${token}`,'Content-Type':'image/jpeg',...extra},body:method==='GET'?undefined:bytes});return {status:r.status,data:r.text};}
ok(await object('POST',member.token));pass('Member uploads storage object');
const duplicate=await object('POST',member.token);assert([400,409].includes(duplicate.status));
assert.equal(createHash('sha256').update(ok(await object('GET',member.token))).digest('hex'),photoHash);pass('Duplicate immutable upload preserves verified bytes');
deny(await object('POST',member.token,'replacement',{'x-upsert':'true'}));deny(await object('PUT',member.token,'replacement'));pass('Storage overwrite and upsert denied');
deny(await object('GET',outsider.token));pass('Outsider cannot read stored attachment');
const read=ok(await object('GET',member.token));assert.equal(read,'test-photo');pass('Original attachment content remains readable');
const deletion=await req('/storage/v1/object/punchlist-attachments',member.token,{prefixes:[path]},'DELETE');assert(deletion.status>=400||JSON.stringify(deletion.data)==='[]',JSON.stringify(deletion));assert.equal(ok(await object('GET',member.token)),'test-photo');pass('Member storage deletion cannot remove object');

const raceArea=randomUUID();
const racers=await Promise.all([phone,computer].map(p_device_id=>rpc('claim_shared_project_area_v2',member.token,{p_project_id:project,p_area_id:raceArea,p_device_id})));
assert.equal(racers.filter(x=>x.status===200).length,1);
assert.equal(racers.filter(x=>x.data.code==='55P03').length,1);pass('Concurrent devices produce exactly one claim winner');
const winningDevice=racers[0].status===200?phone:computer;
const racingPublish={...publish,p_area_id:raceArea,p_device_id:winningDevice,p_area_payload:{...payload,areas:[{id:raceArea,locations:[]}]}};
const writes=await Promise.all([1,2].map(()=>rpc('publish_shared_project_area_snapshot',member.token,{...racingPublish,p_client_id:randomUUID()})));
assert.equal(writes.filter(x=>x.status===200).length,1,JSON.stringify(writes));
assert.equal(writes.filter(x=>[409,503].includes(x.status)).length,1,JSON.stringify(writes));pass('Concurrent same-base publication accepts one and rejects the other');
const loads=await Promise.all(Array.from({length:20},()=>req(`/rest/v1/shared_project_snapshots?project_id=eq.${project}&select=project_id`,member.token,undefined,'GET')));
for(const response of loads) assert.equal(ok(response).length,1);pass('Twenty parallel authenticated snapshot reads succeed');
deny(await rpc('list_unreferenced_shared_attachments',member.token,{p_project_id:project}));ok(await rpc('list_unreferenced_shared_attachments',owner.token,{p_project_id:project}));pass('Attachment cleanup report remains owner-only');
console.log('COMPLETE',results.length);
