import { expect, test } from "bun:test";
import { migrated } from "@repo/db/test-db";
import { createModelKeysService } from "./model-keys.ts";
import { createDictationService, DICTATION_MODELS } from "./dictation.ts";
import { systemClock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const user: Principal = { kind: "user", userId: "u", workspaceId: "org_a", via: "session" };
const wav = () => {
  const bytes = new Uint8Array(364);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0,"RIFF"],[8,"WAVE"],[12,"fmt "],[36,"data"]] as const) {
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  }
  view.setUint32(4,356,true); view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,1,true); view.setUint32(24,16000,true); view.setUint32(28,32000,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true); view.setUint32(40,320,true);
  return Buffer.from(bytes).toString("base64");
};
const setup = async (configured = true, response = new Response(JSON.stringify({ text: "Hello", choices: [{message:{content:"Hello."}}] }))) => {
  const modelKeys = createModelKeysService({ db: migrated(["org_a", "org_b"]), clock: systemClock, secretsKey: Buffer.from(new Uint8Array(32)).toString("base64") });
  if (configured) await modelKeys.set(user, { provider: "openrouter", apiKey: "workspace-only-key" });
  const calls: {url:string; init?:RequestInit}[] = [];
  const fetcher = ((url: unknown, init?: RequestInit) => { calls.push({url:String(url),init}); return Promise.resolve(response.clone()); }) as typeof fetch;
  return { service:createDictationService({modelKeys,fetch:fetcher}), calls };
};
test("workspace key, ASR request and polish model", async () => {
  const {service,calls} = await setup();
  expect(await service.status(user)).toEqual({available:true});
  expect(await service.transcribe(user,{audio:wav(),final:true})).toEqual({text:"Hello"});
  expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
  expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer workspace-only-key");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ model: DICTATION_MODELS.asr, input_audio:{data:wav(),format:"wav"} });
  expect(await service.polish(user,{text:"Hello"})).toEqual({text:"Hello."});
  expect(JSON.parse(String(calls[1]?.init?.body)).model).toBe("anthropic/claude-haiku-5.5");
  expect(DICTATION_MODELS.asr).toBe("nvidia/parakeet-tdt-0.6b-v3");
  expect(await service.status({...user,workspaceId:"org_b"})).toEqual({available:false});
});
test("missing key is unavailable and refuses calls",async()=>{
  const {service,calls}=await setup(false);
  expect(await service.status(user)).toEqual({available:false});
  await expect(service.transcribe(user,{audio:wav(),final:true})).rejects.toThrow("Settings, Model providers");
  expect(calls).toHaveLength(0);
});
test("non-members refused by every method",async()=>{
  const {service,calls}=await setup();
  const outsider: Principal={kind:"system"};
  await expect(service.status(outsider)).rejects.toThrow("Not allowed");
  await expect(service.transcribe(outsider,{audio:wav(),final:true})).rejects.toThrow("Not allowed");
  await expect(service.polish(outsider,{text:"Hello"})).rejects.toThrow("Not allowed");
  expect(calls).toHaveLength(0);
});
test("non-WAV, oversized and forged WAV refused before provider",async()=>{
  const {service,calls}=await setup();
  for(const audio of ["not WAV", "a".repeat(800000), Buffer.from("RIFFxxxxWAVE").toString("base64")]) {
    await expect(service.transcribe(user,{audio,final:false})).rejects.toThrow("WAV");
  }
  expect(calls).toHaveLength(0);
});
test("provider failure is short and excludes body",async()=>{
  const {service}=await setup(true,new Response("secret transcript and key",{status:500}));
  await expect(service.transcribe(user,{audio:wav(),final:true})).rejects.toThrow("Dictation provider unavailable. Try again.");
  await expect(service.polish(user,{text:"Hello"})).rejects.toThrow("Dictation provider unavailable. Try again.");
});
