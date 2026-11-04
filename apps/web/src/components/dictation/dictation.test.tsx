/** biome-ignore-all lint/performance/noJsxPropsBind: React interaction harness. */
/** biome-ignore-all lint/suspicious/useAwait: act flushes React effects. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DictationPreview, useDictation } from "./index.ts";
import type { Capture } from "./capture.ts";
const dom=new Window({url:"http://localhost"});
const previous=new Map<string,PropertyDescriptor|undefined>();
const keys=["window","document","navigator","HTMLElement","Node","IS_REACT_ACT_ENVIRONMENT"];
beforeAll(()=>{ for(const key of keys){ previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,value:key==="IS_REACT_ACT_ENVIRONMENT"?true:Reflect.get(dom,key)}); } });
afterAll(()=>{for(const [key,value] of previous){if(value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key);}});
let state: ReturnType<typeof useDictation>;
let stops=0;
const capture=async(onSamples:(samples:Float32Array)=>void):Promise<Capture>=>{
 onSamples(new Float32Array(1600).fill(.2));
 return {stop:()=>{stops++;},devices:[]};
};
function Harness(){
 const [value,setValue]=useState("before after"); const inputRef=useRef<HTMLTextAreaElement>(null);
 state=useDictation({getValue:()=>value,setValue,inputRef, capture, adapter:{status:async()=>({available:true}),transcribe:async()=>({text:"hello"}),polish:async()=>({text:"Hello."})}});
 return <><textarea ref={inputRef} value={value} readOnly={state.busy} onChange={()=>undefined}/><DictationPreview dictation={state}/></>;
}
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
const mount=async()=>{const node=document.createElement("div"); document.body.append(node); const root=createRoot(node as unknown as Element); await act(async()=>root.render(<Harness/>)); await settle(); const input=node.querySelector("textarea")!; input.focus(); input.setSelectionRange(7,7); return {node,input,root};};
test("click toggles, preview is muted italic and polished text inserts at caret",async()=>{
 const {node,input,root}=await mount();
 await act(async()=>{state.press();state.release();}); await settle();
 expect(state.busy).toBe(true); expect(input.readOnly).toBe(true);
 expect(node.querySelector(".text-muted-foreground.italic")).not.toBeNull();
 await act(async()=>{state.press();state.release();}); await settle();
 expect(input.value).toBe("before Hello.after"); expect(state.busy).toBe(false);
 await act(async()=>root.unmount());
});
test("250ms hold is push to talk; Escape cancels",async()=>{
 const {input,root}=await mount();
 await act(async()=>state.press()); await act(async()=>{await new Promise(resolve=>setTimeout(resolve,260));});
 expect(state.busy).toBe(true);
 await act(async()=>state.release()); await settle(); expect(state.busy).toBe(false);
 await act(async()=>{state.press();state.release();}); await settle();
 await act(async()=>input.dispatchEvent(new dom.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}) as unknown as Event)); await settle();
 expect(state.busy).toBe(false); expect(stops).toBeGreaterThan(0);
 await act(async()=>root.unmount());
});
test("Ctrl+D tap and hold ignore auto repeat",async()=>{
 const {input,root}=await mount();
 const key=(type:string,repeat=false)=>input.dispatchEvent(new dom.KeyboardEvent(type,{key:"d",ctrlKey:true,repeat,bubbles:true,cancelable:true}) as unknown as Event);
 await act(async()=>{key("keydown");key("keydown",true);key("keyup");}); await settle(); expect(state.busy).toBe(true);
 await act(async()=>{key("keydown");key("keyup");}); await settle(); expect(state.busy).toBe(false);
 await act(async()=>key("keydown")); await act(async()=>{await new Promise(resolve=>setTimeout(resolve,260));key("keydown",true);}); expect(state.busy).toBe(true);
 await act(async()=>key("keyup")); await settle(); expect(state.busy).toBe(false);
 await act(async()=>root.unmount());
});
