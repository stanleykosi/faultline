import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {initializePrivateVolume,mountInfoHasExactPath,planPrivateVolumeInitialization,PRIVATE_VOLUME_ROOT} from '../../scripts/initialize-private-volume.mjs';

const rootPermissions={uid:0,gid:0,mode:0o755};
const rootSnapshot={root:PRIVATE_VOLUME_ROOT,rootPermissions,rootDevice:41,entries:[]};
const safeDirectory=name=>({name,symlink:false,directory:true,device:41,uid:0,gid:0,mode:0o755,children:[]});
const safeSystemDirectory=(overrides={})=>({name:'lost+found',symlink:false,directory:true,device:41,uid:0,gid:0,mode:0o700,nlink:2,children:[],...overrides});

function virtualVolume({rootEntries=[],raceAtMkdir,swapAtOpen,failChown}={}){
 const nodes=new Map(),calls=[];let nextInode=2;
 const key=target=>path.resolve(target).toLowerCase();
 const addDirectory=(target,{uid=0,gid=0,mode=0o755,dev=41,ino=nextInode++,nlink=2,directory=true,symlink=false,children=[]}={})=>{
  const item={uid,gid,mode,dev,ino,nlink,directory,symlink,children:[...children]};nodes.set(key(target),item);return item;
 };
 const normalizedRootEntries=rootEntries.map(entry=>typeof entry==='string'?{name:entry}:entry);
 const root=addDirectory(PRIVATE_VOLUME_ROOT,{ino:1,children:normalizedRootEntries.map(entry=>entry.name)});
 for(const entry of normalizedRootEntries)addDirectory(path.join(PRIVATE_VOLUME_ROOT,entry.name),entry);
 const statFor=item=>({dev:item.dev,ino:item.ino,uid:item.uid,gid:item.gid,mode:item.mode,nlink:item.nlink,isSymbolicLink:()=>item.symlink,isDirectory:()=>item.directory,isFile:()=>!item.directory&&!item.symlink});
 const get=target=>nodes.get(key(target));
 const missing=()=>Object.assign(new Error('missing'),{code:'ENOENT'});
 const fsApi={
  async lstat(target){const item=get(target);if(!item)throw missing();return statFor(item);},
  async realpath(target){if(!get(target))throw missing();return path.resolve(target);},
  async readdir(target){const item=get(target);if(!item||!item.directory)throw missing();return [...item.children];},
  async mkdir(target){
   calls.push(['mkdir',path.basename(target)]);
   if(get(target))throw Object.assign(new Error('exists'),{code:'EEXIST'});
   const parent=get(path.dirname(target));if(!parent)throw missing();
   const name=path.basename(target);parent.children.push(name);addDirectory(target);
   if(name===raceAtMkdir)throw Object.assign(new Error('raced create'),{code:'EEXIST'});
  },
  async open(target){
   const item=get(target);if(!item)throw missing();
   const name=path.basename(target);calls.push(['open',name]);
   const opened=statFor(item);
   if(name===swapAtOpen)opened.ino+=1;
   return {
    async stat(){return opened;},
    async chown(uid,gid){calls.push(['chown',name]);if(name===failChown)throw Object.assign(new Error('denied'),{code:'EPERM'});item.uid=uid;item.gid=gid;},
    async chmod(mode){calls.push(['chmod',name]);item.mode=mode;},
    async sync(){calls.push(['sync',name]);},
    async close(){calls.push(['close',name]);},
   };
  },
 };
 return {fsApi,calls,root,nodes,key,get};
}

const runVirtualInitializer=(volume,options={})=>initializePrivateVolume({
 fsApi:volume.fsApi,
 identity:()=>({uid:0}),
 permissionApi:{inspect:(_target,stat)=>({uid:stat.uid,gid:stat.gid,mode:stat.mode&0o777})},
 verifyMount:async root=>assert.equal(root,PRIVATE_VOLUME_ROOT),
 ...options,
});

test('initializer mount parser accepts only an exact mounted path, including escaped spaces',()=>{
 const info='34 25 0:32 / / rw,relatime - overlay overlay rw\n35 34 0:88 / /data rw,nosuid,nodev - ext4 /dev/volume rw\n36 34 0:91 / /some\\040mount rw - ext4 /dev/other rw\n';
 assert.equal(mountInfoHasExactPath(info,'/data'),true);
 assert.equal(mountInfoHasExactPath(info,'/database'),false);
 assert.equal(mountInfoHasExactPath(info,'/some mount'),true);
 assert.equal(mountInfoHasExactPath(info,'data'),false);
});

test('finite plan creates only empty objects/keys directories with the fixed node identity',()=>{
 assert.deepEqual(planPrivateVolumeInitialization(rootSnapshot),[
  {kind:'create_and_assign',name:'objects',uid:1000,gid:1000,mode:0o700},
  {kind:'create_and_assign',name:'keys',uid:1000,gid:1000,mode:0o700},
 ]);
});

test('finite plan preserves an exact empty ext lost+found directory without adding an action',()=>{
 assert.deepEqual(planPrivateVolumeInitialization({...rootSnapshot,entries:[safeSystemDirectory()]}),[
  {kind:'create_and_assign',name:'objects',uid:1000,gid:1000,mode:0o700},
  {kind:'create_and_assign',name:'keys',uid:1000,gid:1000,mode:0o700},
 ]);
});

test('only empty root-owned directories or already-private empty directories may be initialized',()=>{
 assert.deepEqual(planPrivateVolumeInitialization({...rootSnapshot,entries:[safeDirectory('objects'),safeDirectory('keys')]}).map(action=>action.kind),['assign_empty_root_directory','assign_empty_root_directory']);
 const privateDirectory=name=>({...safeDirectory(name),uid:1000,gid:1000,mode:0o700});
 assert.deepEqual(planPrivateVolumeInitialization({...rootSnapshot,entries:[privateDirectory('objects'),privateDirectory('keys')]}).map(action=>action.kind),['verify_only','verify_only']);
});

test('unsafe mount owners/modes, symlinks, hard-to-trust existing data and extra files are refused',async t=>{
 const cases=[
  ['wrong mount owner',{...rootSnapshot,rootPermissions:{uid:7,gid:0,mode:0o755}},'PRIVATE_VOLUME_ROOT_UNSAFE'],
  ['world writable mount',{...rootSnapshot,rootPermissions:{uid:0,gid:0,mode:0o777}},'PRIVATE_VOLUME_ROOT_UNSAFE'],
  ['non-traversable mount',{...rootSnapshot,rootPermissions:{uid:0,gid:0,mode:0o700}},'PRIVATE_VOLUME_ROOT_UNSAFE'],
  ['unexpected root entry',{...rootSnapshot,entries:[{name:'existing.db'}]},'PRIVATE_VOLUME_UNEXPECTED_ENTRY'],
  ['nonempty lost+found',{...rootSnapshot,entries:[safeSystemDirectory({children:['recovered-file']})]},'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
  ['wrong lost+found owner',{...rootSnapshot,entries:[safeSystemDirectory({uid:1000})]},'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
  ['wrong lost+found mode',{...rootSnapshot,entries:[safeSystemDirectory({mode:0o755})]},'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
  ['unexpected lost+found links',{...rootSnapshot,entries:[safeSystemDirectory({nlink:3})]},'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
  ['lost+found symlink',{...rootSnapshot,entries:[safeSystemDirectory({symlink:true})]},'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
  ['lost+found on another device',{...rootSnapshot,entries:[safeSystemDirectory({device:42})]},'PRIVATE_VOLUME_SYSTEM_ENTRY_REFUSED'],
  ['symlink directory',{...rootSnapshot,entries:[{...safeDirectory('objects'),symlink:true}]},'PRIVATE_VOLUME_EXISTING_DATA_REFUSED'],
  ['unexpected existing files',{...rootSnapshot,entries:[{...safeDirectory('keys'),children:['synthetic.key']}]},'PRIVATE_VOLUME_EXISTING_DATA_REFUSED'],
  ['foreign owner',{...rootSnapshot,entries:[{...safeDirectory('objects'),uid:55}]},'PRIVATE_VOLUME_EXISTING_OWNER_REFUSED'],
  ['unsafe mode',{...rootSnapshot,entries:[{...safeDirectory('keys'),mode:0o770}]},'PRIVATE_VOLUME_EXISTING_MODE_REFUSED'],
  ['path on another device',{...rootSnapshot,entries:[{...safeDirectory('keys'),device:42}]},'PRIVATE_VOLUME_EXISTING_DATA_REFUSED'],
 ];
 for(const [name,snapshot,code] of cases)await t.test(name,()=>assert.throws(()=>planPrivateVolumeInitialization(snapshot),error=>error.code===code));
});

test('mutating initializer uses only the injected filesystem and assigns the two empty directories',async()=>{
 const volume=virtualVolume({rootEntries:[safeSystemDirectory()]});
 assert.equal(await runVirtualInitializer(volume),'PRIVATE_VOLUME_READY');
 for(const name of ['objects','keys']){
  const directory=volume.get(path.join(PRIVATE_VOLUME_ROOT,name));
  assert.deepEqual({uid:directory.uid,gid:directory.gid,mode:directory.mode,children:directory.children},{uid:1000,gid:1000,mode:0o700,children:[]});
 }
 assert.deepEqual(volume.calls.filter(([operation])=>operation==='chown').map(([,name])=>name),['objects','keys']);
 assert.equal(volume.calls.filter(([operation])=>operation==='chmod').length,2);
 assert.equal(volume.calls.some(([operation,name])=>(operation==='chown'||operation==='chmod'||operation==='open')&&name==='lost+found'),false);
});

test('mutating initializer refuses an unexpected root entry before changing ownership',async()=>{
 const volume=virtualVolume({rootEntries:['synthetic-user-data.db']});
 await assert.rejects(runVirtualInitializer(volume),error=>error.code==='PRIVATE_VOLUME_UNEXPECTED_ENTRY');
 assert.equal(volume.calls.some(([operation])=>operation==='chown'||operation==='chmod'),false);
});

test('mutating initializer fails closed on a concurrent create or changed directory inode',async t=>{
 await t.test('concurrent create',async()=>{
  const volume=virtualVolume({raceAtMkdir:'objects'});
  await assert.rejects(runVirtualInitializer(volume),error=>error.code==='PRIVATE_VOLUME_CREATE_RACE');
  assert.equal(volume.calls.some(([operation])=>operation==='chown'||operation==='chmod'),false);
 });
 await t.test('directory replaced between lstat and open',async()=>{
  const volume=virtualVolume({swapAtOpen:'objects'});
  await assert.rejects(runVirtualInitializer(volume),error=>error.code==='PRIVATE_VOLUME_SYMLINK_REFUSED');
  assert.equal(volume.calls.some(([operation])=>operation==='chown'||operation==='chmod'),false);
 });
});

test('mutating initializer stops if ownership assignment fails',async()=>{
 const volume=virtualVolume({failChown:'objects'});
 await assert.rejects(runVirtualInitializer(volume),error=>error.code==='PRIVATE_VOLUME_PERMISSION_SET_FAILED');
 const objects=volume.get(path.join(PRIVATE_VOLUME_ROOT,'objects'));
 assert.deepEqual({uid:objects.uid,gid:objects.gid,mode:objects.mode},{uid:0,gid:0,mode:0o755});
 assert.equal(volume.calls.some(([operation,name])=>operation==='chmod'&&name==='objects'),false);
});
