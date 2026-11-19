import {defineConfig,type Plugin} from 'vite';
import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';

const editorUrlId='virtual:body-editor-url',resolvedEditorUrlId='\0'+editorUrlId;
let building=false;
// Expose the emitted module URL so a failed browser import can retry with a fresh
// URL, without parsing browser-specific error strings or reloading the draft.
const editorChunkUrl:Plugin={
  name:'body-editor-chunk-url',
  configResolved(config){building=config.command==='build';},
  resolveId(id){if(id===editorUrlId)return resolvedEditorUrlId;},
  load(id){
    if(id!==resolvedEditorUrlId)return;
    if(!building)return 'export default "/BodyEditorContent.tsx"';
    const ref=this.emitFile({type:'chunk',id:fileURLToPath(new URL('./apps/account/BodyEditorContent.tsx',import.meta.url)),name:'BodyEditorContent',preserveSignature:'strict'});
    return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
  },
};
export default defineConfig({
  root:'apps/account',plugins:[react(),editorChunkUrl],
  optimizeDeps:{include:['@tiptap/react','@tiptap/starter-kit','@tiptap/extension-image']},
  build:{outDir:'../../dist/account',emptyOutDir:true,sourcemap:false},
});
