import {expect} from 'chai'
import sinon from 'sinon'
import * as buoy from '@greymass/buoy'
import {
    Checksum256,
    PermissionLevel,
    PrivateKey,
    ResolvedSigningRequest,
    Transaction,
} from '@wharfkit/session'

import {
    clearTransactionHandoff,
    findReturnedTransactionHandoff,
    isSamePageReturn,
    receiveReturnedTransaction,
    storeTransactionHandoff,
    TransactionHandoff,
    waitForPageReturn,
} from 'src/handoff'

const HANDOFF_KEY = 'wharfkit:anchor-transaction-handoff'

class MockLocalStorage implements Storage {
    data: Record<string, string> = {}
    get length(): number {
        return Object.keys(this.data).length
    }
    clear(): void {
        this.data = {}
    }
    getItem(key: string): string | null {
        return key in this.data ? this.data[key] : null
    }
    key(index: number): string | null {
        return Object.keys(this.data)[index] ?? null
    }
    removeItem(key: string): void {
        delete this.data[key]
    }
    setItem(key: string, value: string): void {
        this.data[key] = value
    }
}

function makePageWindow(href: string) {
    const pageWindow = new EventTarget() as EventTarget & {location: {href: string; hash: string}}
    pageWindow.location = {href, hash: ''}
    return pageWindow
}

function makePageDocument(visibilityState: DocumentVisibilityState = 'visible') {
    const pageDocument = new EventTarget() as EventTarget & {
        visibilityState: DocumentVisibilityState
    }
    pageDocument.visibilityState = visibilityState
    return pageDocument
}

class MockWebSocket {}

const chainId = Checksum256.from('00'.repeat(32))
const transaction = Transaction.from({
    expiration: '2026-08-15T08:00:00',
    ref_block_num: 1,
    ref_block_prefix: 2,
    max_net_usage_words: 0,
    max_cpu_usage_ms: 0,
    delay_sec: 0,
    context_free_actions: [],
    actions: [],
    transaction_extensions: [],
})

function makeHandoff(overrides: Partial<TransactionHandoff> = {}): TransactionHandoff {
    return {
        version: 1,
        returnUrl: 'https://example.com/authorize/anchor#RETURN12',
        callback: {service: 'https://cb.anchor.link', channel: 'callback-channel'},
        transactionId: String(transaction.id),
        chainId: String(chainId),
        actor: 'example',
        permission: 'active',
        expiresAt: '2026-08-15T08:00:00.000Z',
        ...overrides,
    }
}

suite('handoff', () => {
    let storage: MockLocalStorage

    setup(() => {
        sinon.restore()
        storage = new MockLocalStorage()
    })

    teardown(() => {
        sinon.restore()
    })

    suite('isSamePageReturn', () => {
        test('recognizes a return url that only adds a fragment', () => {
            expect(
                isSamePageReturn(
                    'https://example.com/authorize/anchor#RETURN12',
                    'https://example.com/authorize/anchor'
                )
            ).to.be.true
        })

        test('rejects a return url for a different page', () => {
            expect(
                isSamePageReturn(
                    'https://example.com/authorize/anchor#RETURN12',
                    'https://example.com/authorize/anchor?attempt=2'
                )
            ).to.be.false
        })

        test('rejects a return url without a fragment', () => {
            expect(
                isSamePageReturn(
                    'https://example.com/authorize/anchor',
                    'https://example.com/authorize/anchor'
                )
            ).to.be.false
        })
    })

    suite('waitForPageReturn', () => {
        test('resolves when the expected hash arrives', async () => {
            const pageWindow = makePageWindow('https://example.com/authorize/anchor')
            const pageDocument = makePageDocument()
            const pending = waitForPageReturn(
                `${pageWindow.location.href}#RETURN12`,
                undefined,
                pageWindow as unknown as Window,
                pageDocument as unknown as Document
            )
            let completed = false
            void pending.then(() => {
                completed = true
            })

            await Promise.resolve()
            expect(completed).to.be.false

            pageWindow.location.hash = '#RETURN12'
            pageWindow.dispatchEvent(new Event('hashchange'))
            await pending

            expect(completed).to.be.true
        })

        test('resolves after a hide and show round-trip', async () => {
            const pageWindow = makePageWindow('https://example.com/authorize/anchor')
            const pageDocument = makePageDocument()
            const pending = waitForPageReturn(
                `${pageWindow.location.href}#RETURN12`,
                undefined,
                pageWindow as unknown as Window,
                pageDocument as unknown as Document
            )

            pageDocument.visibilityState = 'hidden'
            pageDocument.dispatchEvent(new Event('visibilitychange'))
            pageDocument.visibilityState = 'visible'
            pageDocument.dispatchEvent(new Event('visibilitychange'))

            await pending
        })

        test('resolves on pageshow after pagehide', async () => {
            const pageWindow = makePageWindow('https://example.com/authorize/anchor')
            const pageDocument = makePageDocument()
            const pending = waitForPageReturn(
                `${pageWindow.location.href}#RETURN12`,
                undefined,
                pageWindow as unknown as Window,
                pageDocument as unknown as Document
            )

            pageWindow.dispatchEvent(new Event('pagehide'))
            pageWindow.dispatchEvent(new Event('pageshow'))

            await pending
        })

        test('rejects when aborted', async () => {
            const pageWindow = makePageWindow('https://example.com/authorize/anchor')
            const pageDocument = makePageDocument()
            const controller = new AbortController()
            const pending = waitForPageReturn(
                `${pageWindow.location.href}#RETURN12`,
                controller.signal,
                pageWindow as unknown as Window,
                pageDocument as unknown as Document
            )

            controller.abort()

            let error: Error | undefined
            await pending.catch((err) => {
                error = err
            })
            expect(error?.message).to.equal('Transaction callback wait cancelled')
        })
    })

    suite('transaction handoff storage', () => {
        test('finds only the exact unexpired return url', () => {
            const handoff = makeHandoff()
            storeTransactionHandoff(handoff, storage)

            expect(
                findReturnedTransactionHandoff(
                    handoff.returnUrl,
                    Date.parse('2026-08-15T07:59:00Z'),
                    storage
                )
            ).to.deep.equal(handoff)
            expect(
                findReturnedTransactionHandoff(
                    'https://example.com/authorize/anchor',
                    Date.parse('2026-08-15T07:59:00Z'),
                    storage
                )
            ).to.be.null
        })

        test('removes an expired handoff', () => {
            const handoff = makeHandoff()
            storeTransactionHandoff(handoff, storage)

            expect(
                findReturnedTransactionHandoff(
                    handoff.returnUrl,
                    Date.parse('2026-08-15T08:01:00Z'),
                    storage
                )
            ).to.be.null
            expect(storage.length).to.equal(0)
        })

        test('removes a malformed record', () => {
            storage.setItem(HANDOFF_KEY, 'not json')
            expect(findReturnedTransactionHandoff('https://example.com/', 0, storage)).to.be.null
            expect(storage.length).to.equal(0)

            storage.setItem(HANDOFF_KEY, JSON.stringify({version: 2}))
            expect(findReturnedTransactionHandoff('https://example.com/', 0, storage)).to.be.null
            expect(storage.length).to.equal(0)
        })

        test('does not let an old page clear a newer handoff', () => {
            const oldHandoff = makeHandoff()
            const newHandoff = makeHandoff({
                returnUrl: 'https://example.com/authorize/anchor#NEWFLOW1',
            })
            storeTransactionHandoff(newHandoff, storage)

            clearTransactionHandoff(oldHandoff, storage)

            expect(
                findReturnedTransactionHandoff(
                    newHandoff.returnUrl,
                    Date.parse('2026-08-15T07:59:00Z'),
                    storage
                )
            ).to.deep.equal(newHandoff)
        })

        test('clears its own handoff', () => {
            const handoff = makeHandoff()
            storeTransactionHandoff(handoff, storage)

            clearTransactionHandoff(handoff, storage)

            expect(storage.length).to.equal(0)
        })
    })

    suite('receiveReturnedTransaction', () => {
        test('returns null without a matching handoff', () => {
            const result = receiveReturnedTransaction({
                currentUrl: 'https://example.com/authorize/anchor',
                now: Date.parse('2026-08-15T07:59:00Z'),
                storage,
                abiProvider: {getAbi: sinon.fake()},
            })
            expect(result).to.be.null
        })

        test('reconstructs the signed transaction from the callback', async () => {
            const handoff = makeHandoff()
            const abiProvider = {getAbi: sinon.fake()}
            const signature = PrivateKey.generate('K1').signDigest(
                Checksum256.hash(new TextEncoder().encode('returned'))
            )
            const payload = {
                tx: String(transaction.id),
                req: 'esr:mock',
                sig: String(signature),
                sa: handoff.actor,
                sp: handoff.permission,
                cid: handoff.chainId,
                rbn: '1',
                rid: '2',
                ex: '2026-08-15T08:00:00',
            }
            storeTransactionHandoff(handoff, storage)
            const receiveStub = sinon.stub(buoy, 'receive').resolves(JSON.stringify(payload))
            const fromPayload = sinon.stub(ResolvedSigningRequest, 'fromPayload').resolves({
                transaction,
                chainId,
                signer: PermissionLevel.from(`${handoff.actor}@${handoff.permission}`),
            } as unknown as ResolvedSigningRequest)

            const pending = receiveReturnedTransaction({
                currentUrl: handoff.returnUrl,
                now: Date.parse('2026-08-15T07:59:00Z'),
                storage,
                WebSocket: MockWebSocket as unknown as typeof WebSocket,
                abiProvider,
            })
            if (!pending) throw new Error('Expected a returned transaction')
            const signed = await pending

            expect(signed.signatures.map(String)).to.deep.equal([String(signature)])
            expect(String(signed.id)).to.equal(String(transaction.id))
            expect(fromPayload.calledWithMatch(payload, {abiProvider})).to.be.true
            expect(receiveStub.calledWithMatch(handoff.callback)).to.be.true
            expect(receiveStub.firstCall.args[0].timeout).to.equal(60 * 1000)
            expect(storage.length).to.equal(0)
        })

        test('cancels the buoy receive', async () => {
            const handoff = makeHandoff()
            storeTransactionHandoff(handoff, storage)
            sinon.stub(buoy, 'receive').callsFake(
                (_options, ctx) =>
                    new Promise((_resolve, reject) => {
                        if (ctx) ctx.cancel = () => reject(new Error('Cancelled'))
                    })
            )

            const pending = receiveReturnedTransaction({
                currentUrl: handoff.returnUrl,
                now: Date.parse('2026-08-15T07:59:00Z'),
                storage,
                WebSocket: MockWebSocket as unknown as typeof WebSocket,
                abiProvider: {getAbi: sinon.fake()},
            })
            if (!pending) throw new Error('Expected a returned transaction')

            pending.cancel()

            let error: Error | undefined
            await pending.catch((err) => {
                error = err
            })
            expect(error?.message).to.equal('Cancelled')
            expect(storage.length).to.equal(0)
        })

        test('rejects a callback for a different transaction', async () => {
            const handoff = makeHandoff({transactionId: '11'.repeat(32)})
            const signature = PrivateKey.generate('K1').signDigest(
                Checksum256.hash(new TextEncoder().encode('returned'))
            )
            storeTransactionHandoff(handoff, storage)
            sinon.stub(buoy, 'receive').resolves(
                JSON.stringify({tx: String(transaction.id), sig: String(signature)})
            )
            sinon.stub(ResolvedSigningRequest, 'fromPayload').resolves({
                transaction,
                chainId,
                signer: PermissionLevel.from(`${handoff.actor}@${handoff.permission}`),
            } as unknown as ResolvedSigningRequest)

            const pending = receiveReturnedTransaction({
                currentUrl: handoff.returnUrl,
                now: Date.parse('2026-08-15T07:59:00Z'),
                storage,
                WebSocket: MockWebSocket as unknown as typeof WebSocket,
                abiProvider: {getAbi: sinon.fake()},
            })
            if (!pending) throw new Error('Expected a returned transaction')

            let error: Error | undefined
            await pending.catch((err) => {
                error = err
            })
            expect(error?.message).to.equal('Anchor returned a different transaction')
            expect(storage.length).to.equal(0)
        })
    })
})
