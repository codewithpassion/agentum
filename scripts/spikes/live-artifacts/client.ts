import { strict as assert } from 'node:assert';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const host = 'localhost:18987';
const docs = [new Y.Doc(), new Y.Doc()];
const tickets = docs.map((_, i) => `client${i}-${Date.now()}`);
const providers = docs.map((doc, i) => new YProvider(host, 'test', doc, {party: 'live', params: {ticket: tickets[i]}, disableBc: true, WebSocketPolyfill: WebSocket}));
try {
  await pause(1500);
  docs[0].getText('test').insert(0, 'hello'); await pause(1000);
  assert.equal(docs[0].getText('test').toString(), docs[1].getText('test').toString());
  providers[0].awareness.setLocalStateField('user', {name: 'Forged'}); await pause(500);
  assert([...providers[1].awareness.getStates().values()].some(s => s.user?.name === 'Forged'));
  await fetch(`http://${host}/agent`); await pause(500);
  assert(providers.every(p => [...p.awareness.getStates().values()].some(s => s.user?.name === 'Agent')));
  const before = await (await fetch(`http://${host}/stats`)).json();
  await pause(15000);
  const after = await (await fetch(`http://${host}/stats`)).json();
  assert(after.starts > before.starts); assert.equal(after.sockets, 2);
  docs[1].getText('test').insert(0, '!'); await pause(1000);
  assert.equal(docs[0].getText('test').toString(), docs[1].getText('test').toString());
  const revoked = await (await fetch(`http://${host}/revoke?id=${encodeURIComponent(tickets[0])}`)).json();
  assert.equal(revoked, 1); await pause(500);
  assert.equal(providers[0].wsconnected, false); assert.equal(providers[1].wsconnected, true);
  const replay = await fetch(`http://${host}/parties/live/test?ticket=${encodeURIComponent(tickets[0])}`, {headers: {Upgrade: 'websocket'}});
  assert.equal(replay.status, 403);
  console.log(JSON.stringify({sync: true, spoofRelayed: true, agentOnBoth: true, before, after, postIdleConvergence: true, revoked, replayStatus: replay.status}));
} finally { providers.forEach(p => p.destroy()); docs.forEach(d => d.destroy()); }
