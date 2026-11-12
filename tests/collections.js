// Checks of the database chat after `update` (Anexo B, "Cómo se verifica"). Run by tests/db-ci.sh
// with mongosh as the administrator, connected to the database chat. Every probe document is
// inserted and removed inside this script; prints one "ok"/"FAIL" line per check.
let failures = 0;
const check = (name, fn) => {
  let passed = false;
  try { passed = fn() === true; } catch (e) { passed = false; }
  print(`${passed ? 'ok  ' : 'FAIL'} - ${name}`);
  if (!passed) failures += 1;
};
// rejected(fn): true only when MongoDB refuses the write with a validation or duplicate-key error.
const rejected = (fn) => {
  try { fn(); return false; } catch (e) { return e.code === 121 || e.code === 11000; }
};
// A random v4 UUID in lower case, the shape the validators accept.
const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
const now = new Date();

const conversation = () => ({
  _id: uuid(), productId: uuid(), productName: 'Café especial', buyerId: uuid(),
  buyerName: 'Carlos Pérez', producerId: uuid(), producerName: 'Ana Ruiz',
  agreedPurchaseMethod: null, lastMessageAt: null, createdAt: now,
});
const message = (conversationId) => ({
  _id: uuid(), conversationId, senderId: uuid(), requestId: 'req-1', content: 'Hola', sentAt: now,
});
const event = () => ({
  _id: uuid(), eventType: 'NewChatMessage', routingKey: 'chat.new-message',
  envelope: { eventId: 'x' }, createdAt: now, publishedAt: null, attempts: 0,
});

const names = db.getCollectionNames();
['conversation', 'message', 'outbox_event'].forEach((c) => {
  check(`collection ${c} exists`, () => names.includes(c));
  const info = db.getCollectionInfos({ name: c })[0];
  check(`${c}: validator strict with action error`, () =>
    info.options.validationLevel === 'strict' && info.options.validationAction === 'error'
    && info.options.validator.$jsonSchema.additionalProperties === false);
});

// conversation (AGGR-INV-001, ConversationView)
const valid = conversation();
check('conversation: a valid document is accepted', () => db.conversation.insertOne(valid).acknowledged);
check('conversation: an undeclared field is rejected',
  () => rejected(() => db.conversation.insertOne({ ...conversation(), typo: 1 })));
check('conversation: a method outside its enum is rejected',
  () => rejected(() => db.conversation.insertOne({ ...conversation(), agreedPurchaseMethod: 'CASH' })));
check('conversation: a missing required field is rejected',
  () => rejected(() => { const c = conversation(); delete c.buyerName; db.conversation.insertOne(c); }));
check('conversation: an id that is not a UUID is rejected',
  () => rejected(() => db.conversation.insertOne({ ...conversation(), productId: '42' })));
check('conversation: one per (productId, buyerId) — unique index',
  () => rejected(() => db.conversation.insertOne({ ...conversation(), productId: valid.productId, buyerId: valid.buyerId })));
check('conversation: PLATFORM is accepted',
  () => db.conversation.updateOne({ _id: valid._id }, { $set: { agreedPurchaseMethod: 'PLATFORM' } }).modifiedCount === 1);

// message (AGGR-INV-003, D-C34; requestId of contract §5.3)
const m = message(valid._id);
check('message: a valid document is accepted', () => db.message.insertOne(m).acknowledged);
check('message: empty content is rejected',
  () => rejected(() => db.message.insertOne({ ...message(valid._id), content: '' })));
check('message: content of 2001 characters is rejected',
  () => rejected(() => db.message.insertOne({ ...message(valid._id), content: 'a'.repeat(2001) })));
check('message: content of 2000 characters is accepted',
  () => db.message.insertOne({ ...message(valid._id), requestId: 'req-2000', content: 'a'.repeat(2000) }).acknowledged);
check('message: a requestId longer than 64 is rejected',
  () => rejected(() => db.message.insertOne({ ...message(valid._id), requestId: 'r'.repeat(65) })));
check('message: the same (senderId, requestId) twice is rejected — unique index',
  () => rejected(() => db.message.insertOne({ ...message(valid._id), senderId: m.senderId })));

// outbox_event (ADR-014)
const e = event();
check('outbox_event: a valid document is accepted', () => db.outbox_event.insertOne(e).acknowledged);
check('outbox_event: an unknown event type is rejected',
  () => rejected(() => db.outbox_event.insertOne({ ...event(), eventType: 'Other' })));
check('outbox_event: negative attempts are rejected',
  () => rejected(() => db.outbox_event.insertOne({ ...event(), attempts: -1 })));

// Named indexes (Anexo B rule 2)
const indexNames = (c) => db.getCollection(c).getIndexes().map((i) => i.name);
[
  ['conversation', 'idx_conversation_productId_buyerId'],
  ['conversation', 'idx_conversation_buyerId'],
  ['conversation', 'idx_conversation_producerId'],
  ['message', 'idx_message_conversationId_sentAt'],
  ['message', 'idx_message_senderId_requestId'],
  ['outbox_event', 'idx_outbox_event_publishedAt_createdAt'],
].forEach(([c, n]) => check(`index ${n} exists`, () => indexNames(c).includes(n)));

// chat_writer granted to chat_app, without remove (no soft delete in chat; history is the record)
const role = db.getRole('chat_writer', { showPrivileges: true });
check('role chat_writer exists', () => role !== null);
check('chat_writer has find, insert and update and never remove', () => role.privileges.every((p) =>
  p.actions.includes('find') && p.actions.includes('insert') && p.actions.includes('update')
  && !p.actions.includes('remove')));
check('chat_app holds chat_writer', () =>
  db.getUser('chat_app').roles.some((r) => r.role === 'chat_writer' && r.db === 'chat'));

// Seed of dev and qa (context dev,qa; db-ci runs with no context, so every changeset runs): the
// conversation the checkout E2E flows buy from, the one the WireMock stub answered before.
const seed = db.conversation.findOne({ _id: '7e0b1d2c-3a4f-4b5c-8d6e-9f0a1b2c3d4e' });
check('seed: the checkout conversation exists with PLATFORM', () => seed !== null
  && seed.agreedPurchaseMethod === 'PLATFORM' && seed.productId === '5e1f0c2a-7b3d-4e8f-9a6b-000000000021');

// Clean the probes (as the administrator: chat_app cannot remove).
db.message.deleteMany({ conversationId: valid._id });
db.conversation.deleteOne({ _id: valid._id });
db.outbox_event.deleteOne({ _id: e._id });

print(failures === 0 ? 'collections: all checks passed' : `collections: ${failures} FAIL`);
quit(failures === 0 ? 0 : 1);
