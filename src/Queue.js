import {generateId, sortByPriority} from './shared.js';
import {Message} from './Message.js';

export {Queue, Consumer};

const kConsumers = Symbol.for('consumers');
const kConsuming = Symbol.for('consuming');
const kExclusive = Symbol.for('exclusive');
const kInternalQueue = Symbol.for('internalQueue');
const kIsReady = Symbol.for('isReady');
const kOnConsumed = Symbol.for('kOnConsumed');
const kAvailableCount = Symbol.for('availableCount');
const kStopped = Symbol.for('stopped');

function Queue(name, options, eventEmitter) {
  if (!name) name = `smq.qname-${generateId()}`;
  this.name = name;

  this.options = {autoDelete: true, ...options};

  this.messages = [];
  this.events = eventEmitter;
  this[kConsumers] = [];
  this[kStopped] = false;
  this[kAvailableCount] = 0;
  this[kExclusive] = false;
  this[kOnConsumed] = this._onMessageConsumed.bind(this);
}

Object.defineProperty(Queue.prototype, 'consumerCount', {
  enumerable: true,
  get() {
    return this[kConsumers].length;
  },
});

Object.defineProperty(Queue.prototype, 'consumers', {
  get() {
    return this[kConsumers].slice();
  },
});

Object.defineProperty(Queue.prototype, 'exclusive', {
  get() {
    return this[kExclusive];
  },
});

Object.defineProperty(Queue.prototype, 'messageCount', {
  enumerable: true,
  get() {
    return this.messages.length;
  },
});

Object.defineProperty(Queue.prototype, 'stopped', {
  enumerable: true,
  get() {
    return this[kStopped];
  },
});

Queue.prototype.queueMessage = function queueMessage(fields, content, properties) {
  if (this[kStopped]) return;

  const messageTtl = this.options.messageTtl;
  const messageProperties = {...properties};
  if (messageTtl && !('expiration' in messageProperties)) {
    messageProperties.expiration = messageTtl;
  }
  const message = new Message(fields, content, messageProperties, this[kOnConsumed]);

  const capacity = this._getCapacity();
  this.messages.push(message);
  this[kAvailableCount]++;

  let discarded;
  switch (capacity) {
    case 0:
      discarded = this.evictFirst(message);
      break;
    case 1:
      this.emit('saturated', this);
      break;
  }

  this.emit('message', message);

  return discarded ? 0 : this._consumeNext();
};

Queue.prototype.evictFirst = function evictFirst(compareMessage) {
  const evict = this.get();
  if (!evict) return;
  evict.nack(false, false);
  return evict === compareMessage;
};

Queue.prototype._consumeNext = function consumeNext() {
  if (this[kStopped] || !this[kAvailableCount]) return;

  const consumers = this[kConsumers];
  let consumed = 0;
  if (!consumers.length) return consumed;

  for (const consumer of consumers) {
    if (!consumer.ready) continue;
    const msgs = this._consumeMessages(consumer.capacity, consumer.options);
    if (!msgs.length) return consumed;
    consumer._push(msgs);
    consumed += msgs.length;
  }

  return consumed;
};

Queue.prototype.consume = function consume(onMessage, consumeOptions = {}, owner) {
  const consumers = this[kConsumers];
  const noOfConsumers = consumers.length;

  if (noOfConsumers) {
    if (this[kExclusive]) throw new Error(`Queue ${this.name} is exclusively consumed by ${consumers[0].consumerTag}`);
    if (consumeOptions.exclusive) throw new Error(`Queue ${this.name} already has consumers and cannot be exclusively consumed`);
  }

  const consumer = new Consumer(this, onMessage, consumeOptions, owner, new ConsumerEmitter(this));
  consumers.push(consumer);
  consumers.sort(sortByPriority);

  if (consumer.options.exclusive) {
    this[kExclusive] = true;
  }

  this.emit('consume', consumer);

  const pendingMessages = this._consumeMessages(consumer.capacity, consumer.options);
  if (pendingMessages.length) consumer._push(pendingMessages);

  return consumer;
};

Queue.prototype.assertConsumer = function assertConsumer(onMessage, consumeOptions = {}, owner) {
  const consumers = this[kConsumers];
  if (!consumers.length) return this.consume(onMessage, consumeOptions, owner);
  for (const consumer of consumers) {
    if (consumer.onMessage !== onMessage) continue;

    if (consumeOptions.consumerTag && consumeOptions.consumerTag !== consumer.consumerTag) {
      continue;
    } else if ('exclusive' in consumeOptions && consumeOptions.exclusive !== consumer.options.exclusive) {
      continue;
    }

    return consumer;
  }
  return this.consume(onMessage, consumeOptions, owner);
};

Queue.prototype.get = function getMessage({noAck, consumerTag} = {}) {
  const message = this._consumeMessages(1, {noAck, consumerTag})[0];
  if (!message) return false;
  if (noAck) this._dequeueMessage(message);

  return message;
};

Queue.prototype._consumeMessages = function consumeMessages(n, consumeOptions) {
  const msgs = [];

  if (this[kStopped] || !this[kAvailableCount] || !n) return msgs;

  const messages = this.messages;
  if (!messages.length) return msgs;

  const evict = [];
  for (const message of messages) {
    if (message.pending) continue;
    if (message.properties.expiration && message.properties.ttl < Date.now()) {
      evict.push(message);
      continue;
    }
    message._consume(consumeOptions);
    this[kAvailableCount]--;
    msgs.push(message);
    if (!--n) break;
  }

  if (evict.length) {
    for (const expired of evict) this.nack(expired, false, false);
  }

  return msgs;
};

Queue.prototype.ack = function ack(message, allUpTo) {
  this._onMessageConsumed(message, 'ack', allUpTo, false);
};

Queue.prototype.nack = function nack(message, allUpTo, requeue = true) {
  this._onMessageConsumed(message, 'nack', allUpTo, requeue);
};

Queue.prototype.reject = function reject(message, requeue = true) {
  this._onMessageConsumed(message, 'nack', false, requeue);
};

Queue.prototype._onMessageConsumed = function onMessageConsumed(message, operation, allUpTo, requeue) {
  if (this[kStopped]) return;

  const msgIdx = this._dequeueMessage(message);
  if (msgIdx === -1) return;

  const messages = this.messages;
  const pending = allUpTo && this._getPendingMessages(msgIdx);

  let deadLetterExchange;
  switch (operation) {
    case 'ack':
      break;
    case 'nack': {
      if (requeue) {
        this[kAvailableCount]++;
        messages.splice(msgIdx, 0, new Message({...message.fields, redelivered: true}, message.content, message.properties, this[kOnConsumed]));
      } else {
        deadLetterExchange = this.options.deadLetterExchange;
      }
      break;
    }
  }

  let capacity;
  if (!messages.length) this.emit('depleted', this);
  else if ((capacity = this._getCapacity()) === 1) this.emit('ready', capacity);

  const pendingLength = pending && pending.length;
  if (!pendingLength) this._consumeNext();

  if (!requeue && message.properties.confirm) {
    this.emit('message.consumed.' + operation, {operation, message: {...message}});
  }

  if (deadLetterExchange) {
    const deadLetterRoutingKey = this.options.deadLetterRoutingKey;
    const deadMessage = new Message(message.fields, message.content, {...message.properties, expiration: undefined});
    if (deadLetterRoutingKey) deadMessage.fields.routingKey = deadLetterRoutingKey;

    this.emit('dead-letter', {
      deadLetterExchange,
      message: deadMessage,
    });
  }

  if (pendingLength) {
    for (const msg of pending) {
      msg[operation](false, requeue);
    }
  }
};

Queue.prototype.ackAll = function ackAll() {
  for (const msg of this._getPendingMessages()) {
    msg.ack(false);
  }
};

Queue.prototype.nackAll = function nackAll(requeue = true) {
  for (const msg of this._getPendingMessages()) {
    msg.nack(false, requeue);
  }
};

Queue.prototype._getPendingMessages = function getPendingMessages(untilIndex) {
  const messages = this.messages;
  const l = messages.length;
  const result = [];
  if (!l) return result;

  const until = untilIndex === undefined ? l : untilIndex;

  for (let i = 0; i < until; ++i) {
    const msg = messages[i];
    if (!msg.pending) continue;
    result.push(msg);
  }

  return result;
};

Queue.prototype.peek = function peek(ignoreDelivered) {
  const message = this.messages[0];
  if (!message) return;

  if (!ignoreDelivered) return message;
  if (!message.pending) return message;

  for (const msg of this.messages) {
    if (!msg.pending) return msg;
  }
};

Queue.prototype.cancel = function cancel(consumerTag) {
  const consumers = this[kConsumers];
  const idx = consumers.findIndex((c) => c.consumerTag === consumerTag);
  if (idx === -1) return;

  const consumer = consumers[idx];
  this.unbindConsumer(consumer);
};

Queue.prototype.dismiss = function dismiss(onMessage) {
  const consumers = this[kConsumers];
  const consumer = consumers.find((c) => c.onMessage === onMessage);
  if (!consumer) return;
  this.unbindConsumer(consumer);
};

Queue.prototype.unbindConsumer = function unbindConsumer(consumer) {
  const consumers = this[kConsumers];
  const idx = consumers.indexOf(consumer);
  if (idx === -1) return;

  consumers.splice(idx, 1);

  this[kExclusive] = false;

  consumer.stop();
  consumer.nackAll(true);

  this.emit('consumer.cancel', consumer);

  if (!consumers.length && this.options.autoDelete) return this.emit('delete', this);
};

Queue.prototype.emit = function emit(eventName, content) {
  const eventEmitter = this.events;
  if (!eventEmitter) return;
  eventEmitter.emit(`queue.${eventName}`, content);
};

Queue.prototype.on = function on(eventName, handler) {
  const eventEmitter = this.events;
  if (!eventEmitter) return;
  return eventEmitter.on(`queue.${eventName}`, handler);
};

Queue.prototype.off = function off(eventName, handler) {
  const eventEmitter = this.events;
  if (!eventEmitter) return;
  return eventEmitter.off(`queue.${eventName}`, handler);
};

Queue.prototype.purge = function purge() {
  const toDelete = this.messages.filter(({pending}) => !pending);
  this[kAvailableCount] = 0;

  for (const msg of toDelete) {
    this._dequeueMessage(msg);
  }

  if (!this.messages.length) this.emit('depleted', this);
  return toDelete.length;
};

Queue.prototype._dequeueMessage = function dequeueMessage(message) {
  const messages = this.messages;
  const msgIdx = messages.indexOf(message);
  if (msgIdx === -1) return msgIdx;
  messages.splice(msgIdx, 1);
  return msgIdx;
};

Queue.prototype.getState = function getState() {
  const msgs = this.messages;
  const state = {
    name: this.name,
    options: {...this.options},
  };
  if (msgs.length) {
    try {
      state.messages = JSON.parse(JSON.stringify(msgs));
    } catch (err) {
      err.code = 'EQUEUE_STATE';
      err.queue = this.name;
      throw err;
    }
  }

  return state;
};

Queue.prototype.recover = function recover(state) {
  this[kStopped] = false;
  const consumers = this[kConsumers];
  if (!state) {
    for (const c of consumers.slice()) c.recover();
    return this._consumeNext();
  }

  this.name = state.name;

  this.messages.splice(0);

  let continueConsume;
  if (consumers.length) {
    for (const c of consumers) c.nackAll(false);
    continueConsume = true;
  }

  if (!state.messages) return this;

  const onConsumed = this[kOnConsumed];
  for (const {fields, content, properties} of state.messages) {
    if (properties.persistent === false) continue;
    const msg = new Message({...fields, redelivered: true}, content, properties, onConsumed);
    this.messages.push(msg);
  }
  this[kAvailableCount] = this.messages.length;
  consumers.forEach((c) => c.recover());
  if (continueConsume) {
    this._consumeNext();
  }

  return this;
};

Queue.prototype.delete = function deleteQueue({ifUnused, ifEmpty} = {}) {
  const consumers = this[kConsumers];
  if (ifUnused && consumers.length) return;
  const messages = this.messages;
  if (ifEmpty && messages.length) return;

  this[kStopped] = true;
  const messageCount = messages.length;
  for (const consumer of this[kConsumers].splice(0)) {
    this.emit('consumer.cancel', consumer);
  }

  messages.splice(0);

  this.emit('delete', this);
  return {messageCount};
};

Queue.prototype.close = function close() {
  for (const consumer of this[kConsumers].slice()) {
    this.unbindConsumer(consumer);
  }
};

Queue.prototype.stop = function stop() {
  this[kStopped] = true;
  for (const consumer of this[kConsumers].slice()) {
    consumer.stop();
  }
};

Queue.prototype._getCapacity = function getCapacity() {
  if ('maxLength' in this.options) {
    return this.options.maxLength - this.messages.length;
  }
  return Infinity;
};

function Consumer(queue, onMessage, options, owner, eventEmitter) {
  if (typeof onMessage !== 'function') throw new Error('message callback is required and must be a function');

  this.options = {prefetch: 1, priority: 0, noAck: false, ...options};
  if (!this.options.consumerTag) this.options.consumerTag = 'smq.ctag-' + generateId();

  this.queue = queue;
  this.onMessage = onMessage;
  this.owner = owner;
  this.events = eventEmitter;
  this[kIsReady] = true;
  this[kStopped] = false;
  this[kConsuming] = false;

  this[kInternalQueue] = new Queue(this.options.consumerTag + '-q', {
    autoDelete: false,
    maxLength: this.options.prefetch,
  }, new ConsumerQueueEvents(this));
}

Object.defineProperty(Consumer.prototype, 'consumerTag', {
  enumerable: true,
  get() {
    return this.options.consumerTag;
  },
});

Object.defineProperty(Consumer.prototype, 'ready', {
  enumerable: true,
  get() {
    return this[kIsReady] && !this[kStopped];
  },
});

Object.defineProperty(Consumer.prototype, 'stopped', {
  get() {
    return this[kStopped];
  },
});

Object.defineProperty(Consumer.prototype, 'capacity', {
  get() {
    return this[kInternalQueue]._getCapacity();
  },
});

Object.defineProperty(Consumer.prototype, 'messageCount', {
  get() {
    return this[kInternalQueue].messageCount;
  },
});

Object.defineProperty(Consumer.prototype, 'queueName', {
  get() {
    return this.queue.name;
  },
});

Consumer.prototype._push = function push(messages) {
  const internalQueue = this[kInternalQueue];
  for (const message of messages) {
    internalQueue.queueMessage(message.fields, message, message.properties);
  }
  if (!this[kConsuming]) {
    this._consume();
  }
};

Consumer.prototype._consume = function consume() {
  if (this[kStopped]) return;
  this[kConsuming] = true;
  let msg = this[kInternalQueue].get();

  while (msg) {

    msg._consume(this.options);
    const message = msg.content;
    const _msg = msg;
    message._consume(this.options, () => {
      _msg.ack(false);
    });

    if (this.options.noAck) msg.content.ack();
    this.onMessage(msg.fields.routingKey, msg.content, this.owner);

    this[kConsuming] = false;

    if (this[kStopped]) return;
    this[kConsuming] = true;
    msg = this[kInternalQueue].get();
  }
  this[kConsuming] = false;
};
};

Consumer.prototype.nackAll = function nackAll(requeue) {
  for (const msg of this[kInternalQueue].messages.slice()) {
    msg.content.nack(false, requeue);
  }
};

Consumer.prototype.ackAll = function ackAll() {
  for (const msg of this[kInternalQueue].messages.slice()) {
    msg.content.ack(false);
  }
};

Consumer.prototype.cancel = function cancel(requeue = true) {
  this.stop();
  if (!requeue) this.nackAll(requeue);
  this.emit('cancel', this);
};

Consumer.prototype.prefetch = function prefetch(value) {
  this.options.prefetch = this[kInternalQueue].options.maxLength = value;
};

Consumer.prototype.emit = function emit(eventName, content) {
  const routingKey = `consumer.${eventName}`;
  this.events.emit(routingKey, content);
};

Consumer.prototype.on = function on(eventName, handler) {
  const pattern = `consumer.${eventName}`;
  return this.events.on(pattern, handler);
};

Consumer.prototype.recover = function recover() {
  this[kStopped] = false;
};

Consumer.prototype.stop = function stop() {
  this[kStopped] = true;
};

function ConsumerEmitter(queue) {
  this.queue = queue;
}

ConsumerEmitter.prototype.on = function on(...args) {
  return this.queue.on(...args);
};

ConsumerEmitter.prototype.emit = function emit(eventName, content) {
  if (eventName === 'consumer.cancel') {
    return this.queue.unbindConsumer(content);
  }
  this.queue.emit(eventName, content);
};

function ConsumerQueueEvents(consumer) {
  this.consumer = consumer;
}

ConsumerQueueEvents.prototype.emit = function queueHandler(eventName) {
  switch (eventName) {
    case 'queue.saturated': {
      this.consumer[kIsReady] = false;
      break;
    }
    case 'queue.depleted':
    case 'queue.ready':
      this.consumer[kIsReady] = true;
      break;
  }
};
