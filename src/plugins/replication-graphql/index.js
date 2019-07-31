/**
 * this plugin adds the RxCollection.syncGraphQl()-function to rxdb
 * you can use it to sync collections with remote graphql endpoint
 */

import {
    BehaviorSubject,
    Subject
} from 'rxjs';
import {
    first,
    filter
} from 'rxjs/operators';
import graphQlClient from 'graphql-client';


import {
    promiseWait
} from '../../util';

import Core from '../../core';
import {
    hash,
    clone
} from '../../util';


import {
    DEFAULT_MODIFIER,
    wasRevisionfromPullReplication,
    createRevisionForPulledDocument,
    getDocsWithRevisionsFromPouch
} from './helper';
import {
    setLastPushSequence,
    getLastPullDocument,
    setLastPullDocument,
    getChangesSinceLastPushSequence
} from './crawling-checkpoint';

import RxDBWatchForChangesPlugin from '../watch-for-changes';
import {
    changeEventfromPouchChange
} from '../../rx-change-event';

/**
 * add the watch-for-changes-plugin
 * so pouchdb will emit events when something gets written to it
 */
Core.plugin(RxDBWatchForChangesPlugin);


export class RxGraphQlReplicationState {
    constructor(
        collection,
        url,
        headers,
        pull,
        push,
        deletedFlag,
        live,
        liveInterval,
        retryTime
    ) {
        this.collection = collection;
        this.client = graphQlClient({
            url,
            headers
        });
        this.endpointHash = hash(url);

        this.pull = pull;
        this.push = push;

        this.deletedFlag = deletedFlag;
        this.live = live;
        this.liveInterval = liveInterval;
        this.retryTime = retryTime;

        this._runQueueCount = 0;
        this._subs = [];
        this._runningPromise = Promise.resolve();
        this._subjects = {
            recieved: new Subject(), // all documents that are recieved from the endpoint
            send: new Subject(), // all documents that are send to the endpoint
            error: new Subject(), // all errors that are revieced from the endpoint, emits new Error() objects
            canceled: new BehaviorSubject(false), // true when the replication was canceled
            active: new BehaviorSubject(false), // true when something is running, false when not
            initialReplicationComplete: new BehaviorSubject(false) // true the initial replication-cycle is over
        };

        this._prepare();
    }

    /**
     * things that are more complex to not belong into the constructor
     */
    _prepare() {
        // stop sync when collection gets destroyed
        this.collection.onDestroy.then(() => {
            this.cancel();
        });

        // create getters for the observables
        Object.keys(this._subjects).forEach(key => {
            Object.defineProperty(this, key + '$', {
                get: function () {
                    return this._subjects[key].asObservable();
                }
            });
        });
    }

    isStopped() {
        if (!this.live && this._subjects.initialReplicationComplete._value) return true;
        if (this._subjects.canceled._value) return true;
        else return false;
    }

    awaitInitialReplication() {
        return this.initialReplicationComplete$.pipe(
            filter(v => v === true),
            first()
        ).toPromise();
    }

    // ensures this._run() does not run in parallel
    async run() {
        if (this.isStopped()) {
            return;
        }

        if (this._runQueueCount > 2) {
            return this._runningPromise;
        }

        this._runQueueCount++;
        this._runningPromise = this._runningPromise.then(async () => {
            this._subjects.active.next(true);
            const willRetry = await this._run();
            this._subjects.active.next(false);

            if (!willRetry && this._subjects.initialReplicationComplete._value === false)
                this._subjects.initialReplicationComplete.next(true);

            this._runQueueCount--;
        });
        return this._runningPromise;
    }

    async _run() {
        let willRetry = false;

        if (this.push) {
            const ok = await this.runPush();
            if (!ok) {
                willRetry = true;
                setTimeout(() => this.run(), this.retryTime);
            }
        }

        if (this.pull) {
            const ok = await this.runPull();
            if (!ok) {
                willRetry = true;
                setTimeout(() => this.run(), this.retryTime);
            }
        }

        return willRetry;

    }

    /**
     * @return {boolean} true if no errors occured
     */
    async runPull() {
        // console.log('RxGraphQlReplicationState.runPull(): start');
        if (this.isStopped()) return;

        const latestDocument = await getLastPullDocument(this.collection, this.endpointHash);
        const latestDocumentData = latestDocument ? latestDocument : null;
        const query = this.pull.queryBuilder(latestDocumentData);

        let result;
        try {
            result = await this.client.query(query);
            if (result.errors) {
                throw new Error(result.errors);
            }
        } catch (err) {
            this._subjects.error.next(err);
            setTimeout(() => this.run(), this.retryTime);
            return false;
        }

        // this assumes that there will be always only one property in the response
        // is this correct?
        const data = result.data[Object.keys(result.data)[0]];

        const modified = data.map(doc => this.pull.modifier(doc));

        const docIds = modified.map(doc => doc[this.collection.schema.primaryPath]);
        const docsWithRevisions = await getDocsWithRevisionsFromPouch(
            this.collection,
            docIds
        );
        await Promise.all(modified.map(doc => this.handleDocumentFromRemote(doc, docsWithRevisions)));
        modified.map(doc => this._subjects.recieved.next(doc));

        if (modified.length === 0) {
            if (this.live) {
                // console.log('no more docs, wait for ping');
            } else {
                // console.log('RxGraphQlReplicationState._run(): no more docs and not live; complete = true');
            }
        } else {
            const newLatestDocument = modified[modified.length - 1];
            await setLastPullDocument(
                this.collection,
                this.endpointHash,
                newLatestDocument
            );

            // we have more docs, re-run
            await this.runPull();
        }

        return true;
    }

    async runPush() {
        // console.log('RxGraphQlReplicationState.runPush(): start');

        const changes = await getChangesSinceLastPushSequence(
            this.collection,
            this.endpointHash,
            this.push.batchSize
        );

        const changesWithDocs = changes.results.map(change => {
            let doc = change.doc;

            doc[this.deletedFlag] = !!change.deleted;
            delete doc._rev;
            delete doc._deleted;
            delete doc._attachments;

            doc = this.push.modifier(doc);

            const seq = change.seq;
            return {
                doc,
                seq
            };
        });

        let lastSuccessfullChange = null;
        try {
            /**
             * we cannot run all queries parallel
             * because then we would not know
             * where to start again on errors
             * so we run through the docs in series
             */
            for (let i = 0; i < changesWithDocs.length; i++) {
                const changeWithDoc = changesWithDocs[i];
                const pushObj = this.push.queryBuilder(changeWithDoc.doc);
                const result = await this.client.query(pushObj.query, pushObj.variables);
                if (result.errors) {
                    throw new Error(result.errors);
                } else {
                    this._subjects.send.next(changeWithDoc.doc);
                    lastSuccessfullChange = changeWithDoc;
                }
            }
        } catch (err) {

            if (lastSuccessfullChange) {
                await setLastPushSequence(
                    this.collection,
                    this.endpointHash,
                    lastSuccessfullChange.seq
                );
            }

            this._subjects.error.next(err);
            setTimeout(() => this.run(), this.retryTime);
            return false;
        }

        // all docs where successfull, so we use the seq of the changes-fetch
        await setLastPushSequence(
            this.collection,
            this.endpointHash,
            changes.last_seq
        );

        if (changes.results.length === 0) {
            if (this.live) {
                // console.log('no more docs to push, wait for ping');
            } else {
                // console.log('RxGraphQlReplicationState._runPull(): no more docs to push and not live; complete = true');
            }
        } else {
            // we have more docs, re-run
            await this.runPush();
        }

        return true;
    }

    async handleDocumentFromRemote(doc, docsWithRevisions) {
        const deletedValue = doc[this.deletedFlag];
        const toPouch = this.collection._handleToPouch(doc);
        // console.log('handleDocumentFromRemote(' + toPouch._id + ') start');
        toPouch._deleted = deletedValue;
        delete toPouch[this.deletedFlag];
        const primaryValue = toPouch._id;

        const pouchState = docsWithRevisions[primaryValue];
        let newRevision = createRevisionForPulledDocument(
            this.endpointHash,
            toPouch
        );
        if (pouchState) {
            const newRevisionHeight = pouchState.revisions.start + 1;
            const revisionId = newRevision;
            newRevision = newRevisionHeight + '-' + newRevision;
            toPouch._revisions = {
                start: newRevisionHeight,
                ids: pouchState.revisions.ids
            };
            toPouch._revisions.ids.unshift(revisionId);
        } else {
            newRevision = '1-' + newRevision;
        }
        toPouch._rev = newRevision;

        await this.collection.pouch.bulkDocs(
            [
                toPouch
            ], {
                new_edits: false
            }
        );

        /**
         * because bulkDocs with new_edits: false
         * does not stream changes to the pouchdb,
         * we create the event and emit it,
         * so other instances get informed about it
         */
        const originalDoc = clone(toPouch);
        originalDoc._deleted = deletedValue;
        delete originalDoc[this.deletedFlag];
        originalDoc._rev = newRevision;
        const cE = changeEventfromPouchChange(
            originalDoc,
            this.collection
        );
        this.collection.$emit(cE);
    }

    cancel() {
        if (this.isStopped()) return;

        if (this.changesSub) this.changesSub.cancel();

        this._subjects.canceled.next(true);
        // TODO
    }
}

export function syncGraphQl({
    url,
    headers = {},
    waitForLeadership = true,
    pull,
    push,
    deletedFlag,
    live = false,
    liveInterval = 1000 * 5, // in ms
    retryTime = 1000 * 5, // in ms
    autoStart = true // if this is false, the replication does nothing at start
}) {
    const collection = this;

    // fill in defaults for pull & push
    if (pull) {
        if (!pull.modifier) pull.modifier = DEFAULT_MODIFIER;
    }
    if (push) {
        if (!push.modifier) push.modifier = DEFAULT_MODIFIER;
    }


    // ensure the collection is listening to plain-pouchdb writes
    collection.watchForChanges();

    const replicationState = new RxGraphQlReplicationState(
        collection,
        url,
        headers,
        pull,
        push,
        deletedFlag,
        live,
        liveInterval,
        retryTime
    );

    // run internal so .sync() does not have to be async
    const waitTillRun = waitForLeadership ? this.database.waitForLeadership() : promiseWait(0);
    waitTillRun.then(() => {
        if (!autoStart) return;

        // trigger run once
        replicationState.run();

        // start sync-interval
        if (replicationState.live) {
            (async () => {
                while (!replicationState.isStopped()) {
                    await promiseWait(replicationState.liveInterval);
                    if (replicationState.isStopped()) return;
                    await replicationState.run();
                }
            })();

            if (push) {
                replicationState.changesSub = collection.pouch.changes({
                    since: 'now',
                    live: true,
                    include_docs: true
                }).on('change', function (change) {
                    if (replicationState.isStopped()) return;

                    const rev = change.doc._rev;
                    if (!wasRevisionfromPullReplication(
                        replicationState.endpointHash,
                        rev
                    )) {
                        replicationState.run();
                    }
                });

            }
        }
    });

    return replicationState;
}

export const rxdb = true;
export const prototypes = {
    RxCollection: proto => {
        proto.syncGraphQl = syncGraphQl;
    }
};

export default {
    rxdb,
    prototypes
};