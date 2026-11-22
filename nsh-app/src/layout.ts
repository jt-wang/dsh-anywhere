// Window classes, not device names: resizing and unfolding use the same layout immediately.
import { windowSize } from 'nsh'

export const wideLayout = () => windowSize().width >= 840
export const sidebarWidth = () => Math.min(320, Math.max(296, Math.round(windowSize().width * 0.28)))
/** Bound the reading column with content insets, not a max-width on the virtualized list's flex parent. */
export const conversationInset = (paneWidth: number) => 22 + Math.max(0, Math.round((paneWidth - 840) / 2))
