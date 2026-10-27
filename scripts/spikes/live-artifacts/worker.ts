import { DurableObject } from 'cloudflare:workers';
import { YServer } from 'y-partyserver';
import { routePartykitRequest } from 'partyserver';
import * as awareness from 'y-protocols/awareness';
import * as Y from 'yjs';
import { defaultMarkdownParser, defaultMarkdownSerializer, schema } from 'prosemirror-markdown';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirror } from '@tiptap/y-tiptap';
import { MarkdownManager } from '@tiptap/markdown';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

export class Room extends DurableObject {
  async run() {
    const input = '# Heading\n\nHello **world**.';
    const pm = defaultMarkdownParser.parse(input);
    const doc = prosemirrorJSONToYDoc(schema, pm.toJSON(), 'content');
    const roundtrip = defaultMarkdownSerializer.serialize(yXmlFragmentToProsemirror(schema, doc.getXmlFragment('content')));
    const manager = new MarkdownManager({ extensions: [StarterKit] });
    const tiptapJson = manager.parse(input);
    const tiptapDoc = prosemirrorJSONToYDoc(getSchema([StarterKit]), tiptapJson, 'content');
    const tiptapRoundtrip = manager.serialize(yXmlFragmentToProsemirror(getSchema([StarterKit]), tiptapDoc.getXmlFragment('content')).toJSON());
    const a = new Y.Doc(); a.getText('text').insert(0, 'hello world');
    const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const relative = Y.createRelativePositionFromTypeIndex(a.getText('text'), 6);
    b.getText('text').insert(6, 'human ');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const pos = Y.createAbsolutePositionFromRelativePosition(relative, a);
    a.getText('text').insert(pos.index, 'agent ');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    sql.exec('DELETE FROM chunks');
    const large = new Y.Doc(); large.getText('body').insert(0, 'x'.repeat(5 * 1024 * 1024));
    const snapshot = Y.encodeStateAsUpdate(large);
    const chunkSize = 128 * 1024;
    for (let i = 0; i < snapshot.length; i += chunkSize) sql.exec('INSERT INTO chunks VALUES (?, ?)', i / chunkSize, snapshot.slice(i, i + chunkSize));
    const updateDoc = new Y.Doc(); Y.applyUpdate(updateDoc, snapshot); const updates = []; updateDoc.on('update', u => updates.push(u)); updateDoc.getText('body').insert(0, 'tail'); sql.exec('CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, data BLOB NOT NULL)'); sql.exec('DELETE FROM updates'); for (const [i, update] of updates.entries()) sql.exec('INSERT INTO updates VALUES (?, ?)', i, update);
    const rows = sql.exec('SELECT data FROM chunks ORDER BY id').toArray();
    const bytes = new Uint8Array(snapshot.length); let offset = 0;
    for (const row of rows) { const chunk = new Uint8Array(row.data); bytes.set(chunk, offset); offset += chunk.length; }
    const restored = new Y.Doc(); Y.applyUpdate(restored, bytes); for (const row of sql.exec('SELECT data FROM updates ORDER BY id').toArray()) Y.applyUpdate(restored, new Uint8Array(row.data));
    return {dom: typeof document, roundtrip, tiptapRoundtrip, concurrent: [a.getText('text').toString(), b.getText('text').toString()], snapshotBytes: snapshot.length, chunks: rows.length, updates: updates.length, restoredBytes: restored.getText('body').length};
  }
}
export class Live extends YServer {
  static options = { hibernate: true };
  constructor(ctx, env) { super(ctx, env); this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS used (ticket TEXT PRIMARY KEY)'); this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS starts (n INTEGER)'); this.ctx.storage.sql.exec('INSERT INTO starts VALUES (1)'); }
  consume(ticket) { try { this.ctx.storage.sql.exec('INSERT INTO used VALUES (?)', ticket); return true; } catch { return false; } }
  stats() { return { starts: this.ctx.storage.sql.exec('SELECT count(*) AS n FROM starts').one().n, sockets: this.ctx.getWebSockets().length }; }
  revoke(id) { let count = 0; for (const c of this.getConnections()) if (c.state?.participant === id) { c.close(4001, 'revoked'); count++; } return count; }
  onConnect(conn, ctx) { conn.setState({ participant: new URL(ctx.request.url).searchParams.get('ticket') }); super.onConnect(conn, ctx); }
  agent() { const d = new Y.Doc(); const a = new awareness.Awareness(d); a.setLocalState({ user: { name: 'Agent' }, status: 'Editing' }); awareness.applyAwarenessUpdate(this.document.awareness, awareness.encodeAwarenessUpdate(a, [d.clientID]), null); a.destroy(); d.destroy(); }
}
export default { async fetch(request, env) {
  const url = new URL(request.url); const stub = env.LIVE.getByName('test');
  if (url.pathname === '/stats') return Response.json(await stub.stats());
  if (url.pathname === '/agent') { await stub.agent(); return new Response('ok'); }
  if (url.pathname === '/revoke') return Response.json(await stub.revoke(url.searchParams.get('id')));
  if (url.pathname.startsWith('/parties/')) return await routePartykitRequest(request, env, { onBeforeConnect: async req => { const token = new URL(req.url).searchParams.get('ticket'); if (!token || !await stub.consume(token)) return new Response('denied', {status: 403}); } }) ?? new Response('missing', {status: 404});
  return Response.json(await env.ROOM.getByName('test').run());
} };
