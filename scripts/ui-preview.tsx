import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
const temp = "/tmp/paseo-transfer-ui";
await fs.mkdir(temp, { recursive: true });
const entry = path.join(temp, "entry.tsx");
await fs.writeFile(
  entry,
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {PluginRpcProvider} from '${process.cwd()}/node_modules/@getpaseo/plugin/dist/client/host.js';
import {federation} from '${process.cwd()}/client/federation';
import {TransferSurface,TransferPopover} from '${process.cwd()}/client/surface';
const light=new URLSearchParams(location.search).has('light');
const theme={colors:{surface0:'#15171b',surface1:'#1e2126',surface2:'#2a2e35',border:'#3b414b',foreground:'#eceef2',foregroundMuted:'#aeb6c2',accent:'#8fb7fa',accentForeground:'#111a29',statusSuccess:'#76d6a1',statusWarning:'#e9c274',statusDanger:'#ff9a9a'}};
if(light)Object.assign(theme.colors,{surface0:'#ffffff',surface1:'#f4f5f7',surface2:'#e7eaf0',border:'#a3aab5',foreground:'#202630',foregroundMuted:'#515b6b',accent:'#2556a8',accentForeground:'#ffffff',statusDanger:'#a92525'});
const row={workspaceId:'fixture',name:'Continue the release on my laptop',cwd:'/home/tom/Projects/paseo',isolation:'worktree',project:'Paseo'};
async function invoke(method,input){
if(method==='transfer.hosts')return {hosts:[{target:'laptop',label:'Laptop',source:'ssh'},{target:'desktop',label:'Desktop',source:'tailscale'}]};
if(method==='transfer.workspaces')return {workspaces:[row,{...row,workspaceId:'fixture2',name:'Fix workspace transfers',cwd:'/home/tom/Projects/paseo-transfer'}]};
if(method==='transfer.preview.start')return {previewId:'preview',timeoutSeconds:3600};
if(method==='transfer.preview.status')return {state:'done',message:'Preview ready.',plan:{id:'preview',workspace:row,destination:'/projects/copied-workspace',files:42,sessions:2,bytes:5242880,branch:'release',skipped:[],mode:'copy'}};
if(method==='transfer.preview')return {id:'preview',workspace:row,destination:input.destination,files:42,sessions:2,bytes:5242880,branch:'release',skipped:[],mode:input.mode};
if(method==='transfer.run')return {runId:'run'};
if(method==='transfer.status')return {state:'done',message:'Workspace copied and verified.',result:{workspaceId:'target',cwd:'/home/tom/Projects/paseo-transfer',agents:['claude','codex'],verified:true,sourceArchived:false}};
}
function fixtureRpc(serverId){const tasks=new Map();let seq=0;return async(contract,input)=>{window.fixtureCalls.push({host:serverId,method:contract.name,input});
if(contract.name==='transfer.workspaces')return invoke(contract.name,input);
if(contract.name==='transfer.task.start'){const id=String(++seq);tasks.set(id,input.task);return {id};}
if(contract.name==='transfer.task.status'){const task=tasks.get(input.id);if(task.action==='check')return {state:'done',message:'Checked',destination:task.destination};if(task.action==='receive')return {state:'done',message:'Verified',result:{workspaceId:'received',cwd:'~/Projects/paseo-transfer',agents:[],verified:true,sourceArchived:false}};if(task.action==='archive')return {state:'done',message:'Archived'};return {state:'done',message:'Ready',manifest:{workspace:row,fingerprint:'fixture',sourceId:serverId,files:42,bytes:5242880,branch:'release',hasIgnored:false,sessions:[],wireBytes:10,chunks:1,checksum:'a'.repeat(64)}};}
if(contract.name==='transfer.upload.start')return {id:'upload'};
if(contract.name==='transfer.chunk.read')return {data:'Zml4dHVyZQ=='};
if(contract.name==='transfer.chunk.write')return {next:1};
if(contract.name==='transfer.release')return {released:true};
throw Error('Unexpected fixture RPC '+contract.name);};}
federation.register('laptop',fixtureRpc('laptop'));
federation.register('fixture',fixtureRpc('fixture'));
globalThis.__PASEO_PLUGIN_CLIENT_RUNTIME__={hosts:[{serverId:'fixture',label:'Build host',status:'online'},{serverId:'laptop',label:'Laptop',status:'online'},{serverId:'desktop',label:'Desktop',status:'offline'}]};
for(const element of [document.documentElement,document.body,document.getElementById('root')])element.style.backgroundColor=theme.colors.surface0;
const client=new QueryClient();
window.fixtureCalls=[];
const recordedInvoke=async(method,input)=>{window.fixtureCalls.push({method,input});return invoke(method,input);};
function App(){const [compact,setCompact]=React.useState(innerWidth<700);const [open,setOpen]=React.useState(false);React.useEffect(()=>{const change=()=>setCompact(innerWidth<700);addEventListener('resize',change);return()=>removeEventListener('resize',change);},[]);const props={theme,host:{id:'fixture',label:'Build host'},layout:{compact,platform:'web'}};const page=new URLSearchParams(location.search).has('screen');return <QueryClientProvider client={client}><PluginRpcProvider invoke={recordedInvoke}>{page?<TransferSurface {...props}/>:<div style={{maxWidth:760,margin:'32px auto',padding:'0 16px',fontFamily:'system-ui',color:theme.colors.foreground}}><header style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,borderBottom:'1px solid '+theme.colors.border,paddingBottom:16}}><span style={{fontSize:16,fontWeight:600}}>Release workflow</span><button aria-expanded={open} aria-controls="transfer-popup" onClick={()=>setOpen(!open)} style={{background:theme.colors.surface1,color:theme.colors.foreground,border:'1px solid '+theme.colors.border,borderRadius:6,padding:'10px 14px',fontSize:14,cursor:'pointer'}}>Transfer</button></header>{open&&<div role="dialog" aria-label="Transfer this workspace" id="transfer-popup" style={{display:'flex',flexDirection:'column',boxSizing:'border-box',marginTop:12,marginLeft:'auto',width:compact?'100%':420,maxHeight:440,border:'1px solid '+theme.colors.border,borderRadius:8,overflow:'auto',padding:12,boxShadow:'0 8px 24px rgba(0,0,0,.25)'}}><TransferPopover {...props} context="workspace" workspaceId="fixture" close={()=>setOpen(false)}/></div>}</div>}</PluginRpcProvider></QueryClientProvider>;}
createRoot(document.getElementById('root')).render(<App/>);
`,
);
const hostShim = path.join(temp, "host-shim.ts");
await fs.writeFile(
  hostShim,
  `export * from '${process.cwd()}/node_modules/@getpaseo/plugin/dist/client/index.js';
export function useHosts(){return globalThis.__PASEO_PLUGIN_CLIENT_RUNTIME__.hosts;}`,
);
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: path.join(temp, "bundle.js"),
  jsx: "automatic",
  alias: {
    "@getpaseo/plugin/client": hostShim,
    "react-native": path.join(process.cwd(), "node_modules/react-native-web"),
    react: path.join(process.cwd(), "node_modules/react"),
    "react/jsx-runtime": path.join(
      process.cwd(),
      "node_modules/react/jsx-runtime",
    ),
  },
  nodePaths: [path.join(process.cwd(), "node_modules")],
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "warning",
});
const html =
  '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Transfer preview</title><style>html,body,#root{margin:0;height:100%;background:#15171b}*:focus-visible{outline:2px solid #8fb7fa;outline-offset:2px}::selection{background:#8fb7fa;color:#111a29}*{scrollbar-color:#596271 #15171b}</style><div id="root"></div><script src="/bundle.js"></script></html>';
createServer(async (req, res) => {
  if (req.url === "/bundle.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(await fs.readFile(path.join(temp, "bundle.js")));
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  }
}).listen(8797, "127.0.0.1", () =>
  console.log("UI preview: http://127.0.0.1:8797"),
);
