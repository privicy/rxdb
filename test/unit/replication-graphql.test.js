import assert from 'assert';
import config from './config';

import * as schemaObjects from '../helper/schema-objects';
import * as humansCollection from '../helper/humans-collection';

import * as util from '../../dist/lib/util';
import PouchDB from '../../dist/lib/pouch-db';
import AsyncTestUtil, {
    clone
} from 'async-test-util';
import RxDB from '../../dist/lib/index';
import graphQlPlugin from '../../plugins/replication-graphql';
import * as schemas from '../helper/schemas';

RxDB.plugin(graphQlPlugin);

import graphQlClient from 'graphql-client';

import {
    map,
    filter,
    first
} from 'rxjs/operators';

let SpawnServer;
if (config.platform.isNode()) {
    SpawnServer = require('../helper/graphql-server');
    RxDB.PouchDB.plugin(require('pouchdb-adapter-http'));
}
describe('replication-graphql.test.js', () => {
    const ERROR_URL = 'http://localhost:15898/foobar';
    if (!config.platform.isNode()) return;
    const batchSize = 5;
    const getTestData = (amount) => {
        return new Array(amount).fill(0)
            .map(() => schemaObjects.humanWithTimestamp())
            .map(doc => {
                doc.deleted = false;
                return doc;
            });
    };
    const queryBuilder = doc => {
        if (!doc) {
            doc = {
                id: '',
                updatedAt: 0
            };
        }
        return `{
            feedForRxDBReplication(lastId: "${doc.id}", minUpdatedAt: ${doc.updatedAt}, limit: ${batchSize}) {
                id
                name
                age
                updatedAt
                deleted
            }
        }`;
    };
    config.parallel('graphql-server.js', () => {
        it('spawn, reach and close a server', async () => {
            const server = await SpawnServer.spawn();
            const res = await server.client.query(`{
                 info
            }`);
            assert.equal(res.data.info, 1);
            server.close();
        });
        it('server.setDocument()', async () => {
            const server = await SpawnServer.spawn();
            const doc = getTestData(1).pop();
            const res = await server.setDocument(doc);
            assert.equal(res.data.setHuman.id, doc.id);
            server.close();
        });
    });
    /**
     * we assume some behavior of pouchdb
     * which is ensured with these tests
     */
    config.parallel('assumptions', () => {
        it('should be possible to retrieve deleted documents in pouchdb', async () => {
            const c = await humansCollection.createHumanWithTimestamp(2);
            const pouch = c.pouch;
            const doc = await c.findOne().exec();
            await doc.remove();

            // get deleted and undeleted from pouch
            const deletedDocs = await pouch.allDocs({
                include_docs: true,
                deleted: 'ok'
            });
            assert.equal(deletedDocs.rows.length, 2);
            const deletedDoc = deletedDocs.rows.find(d => d.value.deleted);
            const notDeletedDoc = deletedDocs.rows.find(d => !d.value.deleted);
            assert.ok(deletedDoc);
            assert.ok(notDeletedDoc);

            c.database.destroy();
        });
        it('should be possible to set a custom _rev', async () => {
            const c = await humansCollection.createHumanWithTimestamp(1);
            const pouch = c.pouch;
            const doc = await c.findOne().exec();
            const docData = doc.toJSON();
            const customRev = '2-fadae8ee3847d0748381f13988e95502-rxdb-from-graphql';
            docData._id = docData.id;
            docData._rev = customRev;
            docData.name = 'Alice';

            await pouch.bulkDocs(
                {
                    docs: [docData]
                },
                {
                    new_edits: false
                }
            );


            const pouchDocs = await pouch.find({
                selector: {
                    _id: {}
                }
            });
            assert.equal(pouchDocs.docs.length, 1);
            assert.equal(pouchDocs.docs[0]._rev, customRev);
            assert.equal(pouchDocs.docs[0].name, 'Alice');

            c.database.destroy();
        });
        it('should be possible to delete documents via PouchDB().bulkDocs() with new_edits: false and a custom _rev', async () => {
            const pouch = new PouchDB(
                'pouchdb-test-delete-document-via-bulk-docs',
                {
                    adapter: 'memory'
                }
            );

            const putResult = await pouch.put({
                _id: 'Alice',
                age: 42
            });
            // update once to increase revs
            await pouch.put({
                _id: 'Alice',
                age: 43,
                _rev: putResult.rev
            });

            const allDocs = await pouch.allDocs({});
            const bulkGetDocs = await pouch.bulkGet({
                docs: [
                    {
                        id: 'Alice',
                        rev: allDocs.rows[0].value.rev
                    }
                ],
                revs: true,
                latest: true
            });

            const overwriteDoc = bulkGetDocs.results[0].docs[0].ok;

            const addRev = 'ZZZ-rxdb-from-graphql';
            overwriteDoc._revisions.ids.unshift(addRev);
            overwriteDoc._revisions.start = 3;
            overwriteDoc._deleted = true;
            overwriteDoc._rev = '3-' + addRev;

            await pouch.bulkDocs(
                {
                    docs: [
                        overwriteDoc
                    ],
                    new_edits: false
                },
                {
                }
            );

            const docsAfter = await pouch.allDocs({
                include_docs: true
            });
            assert.equal(docsAfter.rows.length, 0);


            const docsAfterWithDeleted = await pouch.allDocs({
                include_docs: true,
                deleted: 'ok'
            });
            assert.equal(docsAfterWithDeleted.rows.length, 1);

            pouch.destroy();
        });
    });
    config.parallel('live:false pull only', () => {
        it('should pull all documents in one batch', async () => {
            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn(getTestData(batchSize))
            ]);
            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted',
                queryBuilder
            });
            assert.equal(replicationState.isStopped(), false);

            await AsyncTestUtil.waitUntil(async () => {
                const docs = await c.find().exec();
                // console.dir(docs.map(d => d.toJSON()));
                return docs.length === batchSize;
            });

            server.close();
            c.database.destroy();
        });
        it('should pull all documents in multiple batches', async () => {
            const amount = batchSize * 4;
            const testData = getTestData(amount);
            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn(testData)
            ]);

            c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });


            await AsyncTestUtil.waitUntil(async () => {
                const docs = await c.find().exec();
                // console.dir(docs.map(d => d.toJSON()));
                return docs.length === amount;
            });

            // all of test-data should be in the database
            const docs = await c.find().exec();
            const ids = docs.map(d => d.primary);
            const notInDb = testData.find(doc => !ids.includes(doc.id));
            if (notInDb) throw new Error('not in db: ' + notInDb.id);

            server.close();
            c.database.destroy();
        });
        it('should handle deleted documents', async () => {
            const doc = schemaObjects.humanWithTimestamp();
            doc.deleted = true;
            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn([doc])
            ]);

            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });
            await replicationState.awaitInitialReplication();
            const docs = await c.find().exec();
            assert.equal(docs.length, 0);

            server.close();
            c.database.destroy();
        });
        it('should retry on errors', async () => {
            const amount = batchSize * 4;
            const testData = getTestData(amount);

            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn(testData)
            ]);

            const replicationState = c.syncGraphQl({
                url: ERROR_URL,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });
            replicationState.retryTime = 100;


            // on the first error, we switch out the graphql-client
            await replicationState.error$.pipe(
                first()
            ).toPromise().then(() => {
                const client = graphQlClient({
                    url: server.url
                });
                replicationState.client = client;
            });

            await replicationState.awaitInitialReplication();
            const docs = await c.find().exec();
            assert.equal(docs.length, amount);

            server.close();
            c.database.destroy();
        });
    });
    config.parallel('SequenceCheckpoint()', () => {
        it('should get all documents metadata when called the first time', async () => {
            const c = await humansCollection.createHumanWithTimestamp(5);

            const unpushed = await

                c.database.destroy();
        });
    });
    config.parallel('observables', () => {
        it('should emit the recieved documents when replicating', async () => {
            const testData = getTestData(batchSize);
            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn(testData)
            ]);

            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });

            const emitted = [];
            const sub = replicationState.recieved$.subscribe(doc => emitted.push(doc));

            await replicationState.awaitInitialReplication();
            assert.equal(emitted.length, batchSize);
            assert.deepEqual(testData, emitted);

            sub.unsubscribe();
            server.close();
            c.database.destroy();
        });
        it('should complete the replicationState afterwards', async () => {
            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn()
            ]);

            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });
            await replicationState.awaitInitialReplication();
            assert.equal(replicationState.isStopped(), true);

            server.close();
            c.database.destroy();
        });
        it('should emit the correct amount of active-changes', async () => {
            const amount = batchSize * 2;
            const testData = getTestData(amount);

            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn(testData)
            ]);

            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });

            const emitted = [];
            const sub = replicationState.active$.subscribe(d => emitted.push(d));

            await replicationState.awaitInitialReplication();
            console.dir(emitted);

            assert.equal(emitted.length, 7);
            const last = emitted.pop();
            assert.equal(last, false);

            sub.unsubscribe();
            server.close();
            c.database.destroy();
        });
        it('should emit an error when the server is not reachable', async () => {
            const c = await humansCollection.createHumanWithTimestamp(0);
            const replicationState = c.syncGraphQl({
                url: ERROR_URL,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });

            const error = await replicationState.error$.pipe(
                first()
            ).toPromise();

            assert.ok(error.toString().includes('foobar'));

            replicationState.cancel();
            c.database.destroy();
        });
        it('should not exit .run() before the batch is inserted and its events have been emitted', async () => {
            const c = await humansCollection.createHumanWithTimestamp(0);
            const server = await SpawnServer.spawn(getTestData(1));

            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                live: true,
                deletedFlag: 'deleted'
            });
            await replicationState.run();

            await AsyncTestUtil.waitUntil(async () => {
                const docsAfter = await c.find().exec();
                return docsAfter.length === 1;
            });

            const doc = schemaObjects.humanWithTimestamp();
            doc.deleted = false;
            await server.setDocument(doc);

            await replicationState.run();
            // directly after .run(), the doc must be available
            const docsAfter = await c.find().exec();
            assert.equal(docsAfter.length, 2);

            server.close();
            c.database.destroy();
        });
    });
    config.parallel('integrations', () => {
        it('should work with encryption', async () => {
            const db = await RxDB.create({
                name: util.randomCouchString(10),
                adapter: 'memory',
                multiInstance: true,
                queryChangeDetection: true,
                ignoreDuplicate: true,
                password: util.randomCouchString(10)
            });
            const schema = clone(schemas.humanWithTimestamp);
            schema.properties.name.encrypted = true;
            const collection = await db.collection({
                name: 'humans',
                schema
            });

            const testData = getTestData(1);
            testData[0].name = 'Alice';
            const server = await SpawnServer.spawn(testData);

            const replicationState = collection.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });
            await replicationState.awaitInitialReplication();

            const docs = await collection.find().exec();
            assert.equal(docs.length, 1);
            assert.equal(docs[0].name, 'Alice');

            const pouchDocs = await collection.pouch.find({
                selector: {
                    _id: {}
                }
            });
            assert.ok(pouchDocs.docs[0].name !== 'Alice');

            db.destroy();
        });
        it('should work with keyCompression', async () => {
            const db = await RxDB.create({
                name: util.randomCouchString(10),
                adapter: 'memory',
                multiInstance: true,
                queryChangeDetection: true,
                ignoreDuplicate: true,
                password: util.randomCouchString(10)
            });
            const schema = clone(schemas.humanWithTimestamp);
            schema.keyCompression = true;
            const collection = await db.collection({
                name: 'humans',
                schema
            });

            const testData = getTestData(1);
            testData[0].name = 'Alice';
            const server = await SpawnServer.spawn(testData);

            const replicationState = collection.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                deletedFlag: 'deleted'
            });
            await replicationState.awaitInitialReplication();

            const docs = await collection.find().exec();
            assert.equal(docs.length, 1);
            assert.equal(docs[0].name, 'Alice');

            const pouchDocs = await collection.pouch.find({
                selector: {
                    _id: {}
                }
            });

            // first key must be compressed
            assert.ok(Object.keys(pouchDocs.docs[0])[0].startsWith('|'));

            db.destroy();
        });
    });
    config.parallel('live:true pull only', () => {
        it('should also get documents that come in afterwards with active .run()', async () => {
            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),// if this is false, the replication does nothing at start
                SpawnServer.spawn(getTestData(1))
            ]);
            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                live: true,
                deletedFlag: 'deleted'
            });


            // wait until first replication is done
            await replicationState.awaitInitialReplication();

            // add document & trigger pull
            const doc = getTestData(1).pop();
            await server.setDocument(doc);
            await replicationState.run();

            const docs = await c.find().exec();
            assert.equal(docs.length, 2);

            server.close();
            await c.database.destroy();

            // replication should be canceled when collection is destroyed
            assert.ok(replicationState.isStopped());
        });
        it('should also get documents that come in afterwards with interval .run()', async () => {
            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn(getTestData(1))
            ]);
            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                live: true,
                liveInterval: 50,
                deletedFlag: 'deleted'
            });

            await replicationState.awaitInitialReplication();

            // add document & trigger pull
            const doc = getTestData(1).pop();
            await server.setDocument(doc);

            await AsyncTestUtil.waitUntil(async () => {
                const docs = await c.find().exec();
                return docs.length === 2;
            });

            server.close();
            c.database.destroy();
        });
        it('should overwrite the local doc if the remote gets deleted', async () => {
            const testData = getTestData(batchSize);
            const [c, server] = await Promise.all([
                humansCollection.createHumanWithTimestamp(0),
                SpawnServer.spawn(testData)
            ]);
            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                live: true,
                deletedFlag: 'deleted'
            });

            await replicationState.awaitInitialReplication();

            const docs = await c.find().exec();
            assert.equal(docs.length, batchSize);

            const firstDoc = AsyncTestUtil.clone(testData[0]);
            firstDoc.deleted = true;

            await server.setDocument(firstDoc);
            await replicationState.run();

            const docs2 = await c.find().exec();
            assert.equal(docs2.length, batchSize - 1);

            server.close();
            c.database.destroy();
        });
        it('should overwrite the local doc if it was deleted locally', async () => {
            const c = await humansCollection.createHumanWithTimestamp(0);
            const localDoc = schemaObjects.humanWithTimestamp();
            const rxDoc = await c.insert(localDoc);
            await rxDoc.remove();

            const docs = await c.find().exec();
            assert.equal(docs.length, 0);

            const server = await SpawnServer.spawn();
            const replicationState = c.syncGraphQl({
                url: server.url,
                pull: {
                    queryBuilder
                },
                live: true,
                deletedFlag: 'deleted'
            });
            localDoc.deleted = false;
            await server.setDocument(localDoc);
            await replicationState.run();

            const docsAfter = await c.find().exec();
            assert.equal(docsAfter.length, 1);

            server.close();
            c.database.destroy();
        });
    });

    config.parallel('live:false push only', () => {

    });
});