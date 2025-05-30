/**
 * Return PascalCase version of snake_case string.
 * @internal
 */
export function snakeToPascal(name: string): string {
    return name
        .split('_')
        .map((v) => (v[0] ? v[0].toUpperCase() : '') + v.slice(1))
        .join('')
}

/**
 * Return camelCase version of snake_case string.
 * @internal
 */
export function snakeToCamel(name: string): string {
    const pascal = snakeToPascal(name)

    return (pascal[0] ? pascal[0].toLowerCase() : '') + pascal.slice(1)
}

/**
 * Print a warning message to console.
 * @internal
 **/
export function logWarn(...args: any[]) {
    // eslint-disable-next-line no-console
    console.warn('[anchor-link]', ...args)
}

/**
 * Generate a UUID.
 *  @internal
 * */

export function uuid(): string {
    let uuid = '',
        ii
    const chars = '0123456789abcdef'
    for (ii = 0; ii < 36; ii += 1) {
        switch (ii) {
            case 8:
            case 13:
            case 18:
            case 23:
                uuid += '-'
                break
            case 14:
                uuid += '4'
                break
            case 19:
                uuid += chars[(Math.random() * 4) | (0 + 8)]
                break
            default:
                uuid += chars[(Math.random() * 16) | 0]
        }
    }
    return uuid
}

/** Generate a return url that Anchor will redirect back to w/o reload. */
export function generateReturnUrl(): string | undefined {
    // Return undefined for iOS React Native apps to prevent redirect to Safari
    if (isAppleHandheld() && isReactNativeApp()) {
        return undefined
    }

    if (isChromeiOS()) {
        // google chrome on iOS will always open new tab so we just ask it to open again as a workaround
        return 'googlechrome://'
    }
    if (isFirefoxiOS()) {
        // same for firefox
        return 'firefox:://'
    }
    if (isAppleHandheld() && isBrave()) {
        // and brave ios
        return 'brave://'
    }
    if (isAppleHandheld()) {
        // return url with unique fragment required for iOS safari to trigger the return url
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        let rv = window.location.href.split('#')[0] + '#'
        for (let i = 0; i < 8; i++) {
            rv += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
        }
        return rv
    }

    if (isAndroid() && isFirefox()) {
        return 'android-app://org.mozilla.firefox'
    }

    if (isAndroid() && isEdge()) {
        return 'android-app://com.microsoft.emmx'
    }

    if (isAndroid() && isOpera()) {
        return 'android-app://com.opera.browser'
    }

    if (isAndroid() && isBrave()) {
        return 'android-app://com.brave.browser'
    }

    if (isAndroid() && isAndroidWebView()) {
        return 'android-app://webview'
    }

    if (isAndroid() && isChromeMobile()) {
        return 'android-app://com.android.chrome'
    }

    return window.location.href
}

export function isAppleHandheld() {
    return /iP(ad|od|hone)/i.test(navigator.userAgent)
}

export function isChromeiOS() {
    return /CriOS/.test(navigator.userAgent)
}

export function isChromeMobile() {
    return /Chrome\/[.0-9]* Mobile/i.test(navigator.userAgent)
}

export function isFirefox() {
    return /Firefox/i.test(navigator.userAgent)
}

export function isFirefoxiOS() {
    return /FxiOS/.test(navigator.userAgent)
}

export function isOpera() {
    return /OPR/.test(navigator.userAgent) || /Opera/.test(navigator.userAgent)
}

export function isEdge() {
    return /Edg/.test(navigator.userAgent)
}

export function isBrave() {
    return navigator['brave'] && typeof navigator['brave'].isBrave === 'function'
}

export function isAndroid() {
    return /Android/.test(navigator.userAgent)
}

export function isReactNativeApp() {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return !!window.ReactNativeWebView
}

export function isAndroidWebView() {
    return (
        /wv/.test(navigator.userAgent) ||
        (/Android/.test(navigator.userAgent) && isReactNativeApp())
    )
}

export function isKnownMobile() {
    return (
        isAppleHandheld() ||
        isChromeiOS() ||
        isChromeMobile() ||
        isFirefoxiOS() ||
        isAndroid() ||
        isAndroidWebView()
    )
}
