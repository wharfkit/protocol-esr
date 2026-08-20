import {receive, ReceiveContext} from '@greymass/buoy'
import {
    AbiProvider,
    CallbackPayload,
    Cancelable,
    ResolvedSigningRequest,
    SignedTransaction,
} from '@wharfkit/session'
import zlib from 'pako'

import {extractSignaturesFromCallback, isCallback} from './esr'

const TRANSACTION_HANDOFF_KEY = 'wharfkit:anchor-transaction-handoff'

interface CallbackChannel {
    channel: string
    service: string
}

export interface TransactionHandoff {
    version: 1
    returnUrl: string
    callback: CallbackChannel
    transactionId: string
    chainId: string
    actor: string
    permission: string
    expiresAt: string
}

function isCallbackChannel(value: unknown): value is CallbackChannel {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Record<string, unknown>
    return typeof candidate.channel === 'string' && typeof candidate.service === 'string'
}

function isTransactionHandoff(value: unknown): value is TransactionHandoff {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Record<string, unknown>
    return (
        candidate.version === 1 &&
        typeof candidate.returnUrl === 'string' &&
        isCallbackChannel(candidate.callback) &&
        typeof candidate.transactionId === 'string' &&
        typeof candidate.chainId === 'string' &&
        typeof candidate.actor === 'string' &&
        typeof candidate.permission === 'string' &&
        typeof candidate.expiresAt === 'string'
    )
}

/** Check whether returnUrl differs from currentUrl only by a non-empty fragment. */
export function isSamePageReturn(returnUrl: string, currentUrl = window.location.href): boolean {
    const current = new URL(currentUrl)
    const target = new URL(returnUrl, current)
    const targetHash = target.hash
    current.hash = ''
    target.hash = ''
    return targetHash.length > 1 && current.href === target.href
}

/** Resolve once the page returns from an app handoff: the return hash arrives or the page is re-shown. */
export function waitForPageReturn(
    returnUrl: string,
    signal?: AbortSignal,
    pageWindow: Window = window,
    pageDocument: Document = document
): Promise<void> {
    const expectedHash = new URL(returnUrl, pageWindow.location.href).hash
    let departed = pageDocument.visibilityState === 'hidden'
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            pageWindow.removeEventListener('hashchange', onHashChange)
            pageWindow.removeEventListener('pagehide', onPageHide)
            pageWindow.removeEventListener('pageshow', onPageShow)
            pageDocument.removeEventListener('visibilitychange', onVisibilityChange)
            signal?.removeEventListener('abort', onAbort)
        }
        const finish = () => {
            cleanup()
            resolve()
        }
        const onHashChange = () => {
            if (expectedHash && pageWindow.location.hash === expectedHash) finish()
        }
        const onPageHide = () => {
            departed = true
        }
        const onPageShow = () => {
            if (departed) finish()
        }
        const onVisibilityChange = () => {
            if (pageDocument.visibilityState === 'hidden') {
                departed = true
            } else if (departed) {
                finish()
            }
        }
        const onAbort = () => {
            cleanup()
            reject(new Error('Transaction callback wait cancelled'))
        }

        pageWindow.addEventListener('hashchange', onHashChange)
        pageWindow.addEventListener('pagehide', onPageHide)
        pageWindow.addEventListener('pageshow', onPageShow)
        pageDocument.addEventListener('visibilitychange', onVisibilityChange)
        signal?.addEventListener('abort', onAbort, {once: true})
        if (signal?.aborted) onAbort()
    })
}

export function storeTransactionHandoff(
    handoff: TransactionHandoff,
    storage: Storage = window.localStorage
): void {
    storage.setItem(TRANSACTION_HANDOFF_KEY, JSON.stringify(handoff))
}

export function findReturnedTransactionHandoff(
    currentUrl = window.location.href,
    now = Date.now(),
    storage: Storage = window.localStorage
): TransactionHandoff | null {
    const encoded = storage.getItem(TRANSACTION_HANDOFF_KEY)
    if (!encoded) return null
    let handoff: unknown
    try {
        handoff = JSON.parse(encoded)
    } catch {
        storage.removeItem(TRANSACTION_HANDOFF_KEY)
        return null
    }
    if (!isTransactionHandoff(handoff)) {
        storage.removeItem(TRANSACTION_HANDOFF_KEY)
        return null
    }
    const expiresAt = Date.parse(handoff.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        storage.removeItem(TRANSACTION_HANDOFF_KEY)
        return null
    }
    try {
        return new URL(currentUrl).href === new URL(handoff.returnUrl).href ? handoff : null
    } catch {
        storage.removeItem(TRANSACTION_HANDOFF_KEY)
        return null
    }
}

export function clearTransactionHandoff(
    handoff: TransactionHandoff,
    storage: Storage = window.localStorage
): void {
    const current = findReturnedTransactionHandoff(handoff.returnUrl, 0, storage)
    if (current?.returnUrl === handoff.returnUrl) {
        storage.removeItem(TRANSACTION_HANDOFF_KEY)
    }
}

/** Receive the buffered signed transaction for a stored handoff, or null when none matches the current URL. */
export function receiveReturnedTransaction(options: {
    currentUrl?: string
    now?: number
    storage?: Storage
    WebSocket?: typeof WebSocket
    abiProvider: AbiProvider
}): Cancelable<SignedTransaction> | null {
    const storage = options.storage ?? window.localStorage
    const now = options.now ?? Date.now()
    const handoff = findReturnedTransactionHandoff(options.currentUrl, now, storage)
    if (!handoff) return null
    const ctx: ReceiveContext = {}
    const pending = receive(
        {
            ...handoff.callback,
            WebSocket: options.WebSocket ?? WebSocket,
            timeout: Math.max(1, Date.parse(handoff.expiresAt) - now),
        },
        ctx
    )
    const transaction = pending
        .then(async (response) => {
            if (typeof response !== 'string') {
                throw new Error('Anchor did not return a signed transaction')
            }
            const payload: CallbackPayload = JSON.parse(response)
            const signatures = extractSignaturesFromCallback(payload)
            if (!isCallback(payload) || signatures.length === 0) {
                throw new Error('Anchor did not return a signed transaction')
            }
            const resolved = await ResolvedSigningRequest.fromPayload(payload, {
                zlib,
                abiProvider: options.abiProvider,
            })
            if (
                String(resolved.transaction.id) !== handoff.transactionId ||
                String(resolved.chainId) !== handoff.chainId ||
                String(resolved.signer.actor) !== handoff.actor ||
                String(resolved.signer.permission) !== handoff.permission
            ) {
                throw new Error('Anchor returned a different transaction')
            }
            return SignedTransaction.from({
                ...resolved.transaction,
                signatures,
            })
        })
        .finally(() => clearTransactionHandoff(handoff, storage)) as Cancelable<SignedTransaction>
    transaction.cancel = () => {
        ctx.cancel?.()
        return transaction
    }
    return transaction
}
