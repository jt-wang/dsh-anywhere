// Icons: one-colour SVGs tinted with the theme (`tint-*`), the round icon button used in headers and the composer,
// the action sheet every menu on the phone uses, and the phone's haptics.
import { createMotion, effect, host, Image, Keyboard, keyboardFrame, LayoutAnimation, Overlay, platform, safeAreaInsets, signal, Text, untracked, View, type Bounds, type JSX, type Point, type PressEvent, type Signal, type ViewRef, windowSize } from 'nsh'
import { Sheet, type SheetProps } from 'nsh/base'
import { coverWorkingText } from './work-cover.ts'
import { bySize, SIZES } from './icons.gen.ts'
import archive from '../assets/icons/archive.svg'
import check from '../assets/icons/check.svg'
import copy from '../assets/icons/copy.svg'
import textSelect from '../assets/icons/text-select.svg'
import image from '../assets/icons/image.svg'
import pencil from '../assets/icons/pencil.svg'
import pin from '../assets/icons/pin.svg'
import restore from '../assets/icons/restore.svg'
import unlink from '../assets/icons/unlink.svg'
import arrowUp from '../assets/icons/arrow-up.svg'
import chevronDown from '../assets/icons/chevron-down.svg'
import chevronRight from '../assets/icons/chevron-right.svg'
import disclosureDown from '../assets/icons/disclosure-down.svg'
import disclosureRight from '../assets/icons/disclosure-right.svg'
import compose from '../assets/icons/compose.svg'
import file from '../assets/icons/file.svg'
import folder from '../assets/icons/folder.svg'
import more from '../assets/icons/more.svg'
import plus from '../assets/icons/plus.svg'
import search from '../assets/icons/search.svg'
import x from '../assets/icons/x.svg'
import sliders from '../assets/icons/sliders.svg'
import fork from '../assets/icons/fork.svg'
import terminal from '../assets/icons/terminal.svg'
import listChecks from '../assets/icons/list-checks.svg'
import at from '../assets/icons/at.svg'
import message from '../assets/icons/message.svg'
import bot from '../assets/icons/bot.svg'
import clock from '../assets/icons/clock.svg'
import info from '../assets/icons/info.svg'
import route from '../assets/icons/route.svg'
import mic from '../assets/icons/mic.svg'
import globe from '../assets/icons/globe.svg'
import layers from '../assets/icons/layers.svg'
import monitor from '../assets/icons/monitor.svg'
import puzzle from '../assets/icons/puzzle.svg'
import repeat from '../assets/icons/repeat.svg'
import user from '../assets/icons/user.svg'

export const icons = { archive, arrowUp, at, bot, check, chevronDown, chevronRight, clock, compose, copy, file, folder, fork, globe, image, info, layers, listChecks, message, mic, monitor, more, pencil, pin, plus, puzzle, repeat, restore, route, search, sliders, terminal, textSelect, unlink, user, x }
export type IconName = keyof typeof icons

/** The sizes icons come in: each draws a 1.5 pt line (scripts/icon-strokes.mjs). */
export type IconSize = typeof SIZES[number]
export const iconAsset = (name: IconName, size: IconSize) => bySize[size][name]

export function Icon(props: { name: IconName; size?: IconSize; class?: string }) {
  const size = props.size ?? 18
  return <Image src={iconAsset(props.name, size)} style={{ width: size, height: size }} class={props.class ?? 'tint-muted-foreground'} />
}

/** The chevron after a label (a dropdown, a disclosure, a row that opens): drawn edge to edge in its frame, so the gap
 * and padding around it are the space a person sees; 0.6 of the label's font size wide, its stroke about as heavy as
 * the label's stems (1.4 of 10 units at that width), in the label's colour. */
export function Chevron(props: { dir: 'down' | 'up' | 'right'; font: number; class?: string; onLayout?: (e: { bounds: Bounds }) => void }) {
  const long = Math.round(props.font * 0.6 * 2) / 2, short = Math.round(long * 0.6 * 10) / 10
  const down = props.dir !== 'right'
  return (
    <View onLayout={props.onLayout} style={{ width: down ? long : short, height: down ? short : long }}>
      <Image src={down ? disclosureDown : disclosureRight} style={{ width: down ? long : short, height: down ? short : long, transform: props.dir === 'up' ? 'rotate(180deg)' : 'none' }} class={props.class ?? 'tint-muted-foreground'} />
    </View>
  )
}

/** A button that opens a list to choose from (the model picker): its label, then a chevron 5 pt after it, and the
 * same 10 pt of space on both sides. */
export function DropdownButton(props: { label: string; onPress: () => void; testID?: string; accessibilityLabel?: string; maxLabelWidth?: number
  onButtonLayout?: (e: { bounds: Bounds }) => void; onLabelLayout?: (e: { bounds: Bounds }) => void; onChevronLayout?: (e: { bounds: Bounds }) => void }) {
  return (
    <View role="button" testID={props.testID} accessibilityLabel={props.accessibilityLabel} onPress={props.onPress} hitSlop={6} onLayout={props.onButtonLayout}
      class="shrink min-w-[44px] flex-row items-center gap-[5px] h-[36px] px-[10px] rounded-full active:bg-secondary">
      <Text onLayout={props.onLabelLayout} class="min-w-0 shrink text-muted-foreground text-[13px] line-clamp-1" style={{ maxWidth: props.maxLabelWidth ?? 200 }}>{props.label}</Text>
      <Chevron dir="down" font={13} onLayout={props.onChevronLayout} />
    </View>
  )
}

const ICON_SLOP = 6
/** Compact visual controls retain a 48 dp touch target through their 6 dp hit slop. */
export function IconButton(props: { name: IconName; label: string; onPress: (e?: PressEvent) => void; onPressDown?: () => void; onPressUp?: () => void; onTouchStart?: () => void; onTouchEnd?: () => void; onTouchCancel?: () => void; testID?: string; size?: IconSize; class?: string; iconClass?: string }) {
  return (
    <View role="button" accessibilityLabel={props.label} testID={props.testID} onPress={props.onPress} onPressDown={props.onPressDown} onPressUp={props.onPressUp}
      onTouchStart={props.onTouchStart} onTouchEnd={props.onTouchEnd} onTouchCancel={props.onTouchCancel} hitSlop={ICON_SLOP}
      class={`w-[36px] h-[36px] rounded-full items-center justify-center active:bg-secondary ${props.class ?? ''}`}>
      <Icon name={props.name} size={props.size ?? 20} class={props.iconClass ?? 'tint-foreground'} />
    </View>
  )
}


/** The next update's size changes animate, as a panel opening does elsewhere in the app. */
export const glide = () => LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'))

const insets = safeAreaInsets()
/** Bottom padding of a sheet: above the keyboard while it is up, else above the system bar. */
export const sheetBottom = () => Math.max(keyboardFrame().height, insets().bottom) + 8
/** Height limit of a sheet whose content stops at `cap`: the bottom padding (`sheetBottom`, the keyboard while it is
 * up) comes on top of the cap, and the sheet stays 8 pt below the status bar. */
export function sheetMaxHeight(cap: number, at: { window: number; top: number; bottom: number }) {
  return Math.min(cap + at.bottom, at.window - at.top - 8)
}
/** `sheetMaxHeight` on this screen, now. */
export const sheetMax = (cap: number) => sheetMaxHeight(cap, { window: windowSize().height, top: insets().top, bottom: sheetBottom() })

/** List rows, connections and background work are static. Only the current working text may animate. */
export function LiveDot(props: { size?: number; class?: string }) {
  return <View testID="live-dot" class={`rounded-full bg-live ${props.class ?? ''}`} style={{ width: props.size ?? 6, height: props.size ?? 6 }} />
}

export const SHEET = 'bg-background rounded-t-[28px]'
export const SCRIM = { backgroundColor: 'rgba(0, 0, 0, 0.32)' }

// Apple control material only; the transcript stays opaque. Android keeps a tonal Material surface, not faux glass.
const appleMaterial = platform.os === 'ios' || platform.os === 'macos'
const composerMaterial = { glassEffect: 'regular' as const, backdropFilter: 'blur(12px)' }

/** Keep the focus stroke outside Apple's material view so native glass cannot cover its restyle. */
export function ComposerFrame(props: { children?: JSX.Element | JSX.Element[] }) {
  const frame = 'rounded-[21px] border border-input focus-within:border-ring'
  return appleMaterial
    ? <View class={frame}><View class="rounded-[20px] bg-card/80" style={composerMaterial}>{props.children}</View></View>
    : <View class={`${frame} bg-card`}>{props.children}</View>
}

/** The app's bottom sheet: Material 3's look, closed by a swipe down, and the keyboard put away as it opens, so a sheet
 * opened while the person types is never behind the keyboard or on top of it. Every sheet of the app is one. An input
 * inside the sheet can take the focus after it opens; the sheet then sits above the keyboard (`sheetBottom`). */
export function BottomSheet(props: Omit<SheetProps, 'popupClass' | 'backdropStyle' | 'closeOnSwipe'> & { closeOnSwipe?: boolean }) {
  const visible = signal(props.open ?? props.defaultOpen ?? false)
  coverWorkingText(visible)
  effect(() => { if (props.open) { visible.set(true); untracked(() => Keyboard.dismiss()) } })
  // Keep covered until the exit finishes, including during a handoff to another sheet.
  return <Sheet closeOnSwipe {...props} popupClass={SHEET} backdropStyle={SCRIM}
    onOpenChange={(e) => { if (e.open) visible.set(true); props.onOpenChange?.(e) }}
    onClose={() => { if (!props.open) visible.set(false); props.onClose?.() }} />
}
/** The sheet's drag handle, 32 × 4 pt. */
export function Grabber() { return <View class="self-center w-8 h-1 rounded-full bg-input mb-2" /> }

/** The phone's own feedback for a moment (the app's `haptic`: Android's HapticFeedbackConstants). */
export type Haptic = 'tick' | 'press' | 'confirm' | 'reject' | 'threshold' | 'unthreshold'
export const haptic = (kind: Haptic) => { host.call('haptic', { kind }).catch(() => {}) }

export interface SheetAction { id: string; label: string; icon?: IconName; destructive?: boolean; /** A setting that is on: a check after it. */ checked?: boolean }
interface Asked { title?: string; message?: string; actions: SheetAction[]; resolve: (id: string | undefined) => void }
const asked = signal<Asked | undefined>(undefined)
const shown = signal(false)

/** Asks which of `actions` to take in a sheet at the bottom; undefined when the person closes it. With a `message`,
 * the sheet is a confirmation: `title` is its question as a heading, `message` what happens. */
export function chooseAction(options: { title?: string; message?: string; actions: SheetAction[] }): Promise<string | undefined> {
  asked()?.resolve(undefined)
  return new Promise((resolve) => { asked.set({ ...options, resolve }); shown.set(true) })
}

/** Where `chooseAction` shows its sheet: once, at the app's root. */
export function ActionSheetHost() {
  const answer = (id: string | undefined) => { asked()?.resolve(id); asked.set({ ...asked()!, resolve: () => {} }); shown.set(false) }
  return (
    <BottomSheet open={shown()} onOpenChange={(e) => { if (!e.open) answer(undefined) }} onClose={() => asked.set(undefined)}>
      <View class="pt-[10px]" style={{ paddingBottom: insets().bottom + 8 }} testID="action-sheet">
        <Grabber />
        <If when={asked()?.message} else={<If when={asked()?.title}><Text class="px-5 pt-1 pb-2 text-muted-foreground text-[13px] leading-[18px] line-clamp-3">{asked()?.title}</Text></If>}>
          <View class="px-5 pt-1 pb-3 gap-[6px]">
            <Text testID="action-sheet-title" class="text-foreground text-[17px] leading-[22px] font-semibold">{asked()?.title}</Text>
            <Text testID="action-sheet-message" class="text-muted-foreground text-[14px] leading-[20px]">{asked()?.message}</Text>
          </View>
        </If>
        {(asked()?.actions ?? []).map((a) => (
          <View role="button" testID={`action-${a.id}`} onPress={() => { haptic('tick'); answer(a.id) }}
            class="flex-row items-center gap-[14px] mx-2 px-3 h-[52px] rounded-[12px] active:bg-secondary transition-colors duration-150">
            {a.icon ? <Icon name={a.icon} size={20} class={a.destructive ? 'tint-destructive' : 'tint-foreground'} /> : null}
            <Text class={`flex-1 text-[15px] ${a.destructive ? 'text-destructive' : 'text-foreground'}`}>{a.label}</Text>
            {a.checked ? <View testID={`action-${a.id}-on`}><Icon name="check" size={18} /></View> : null}
          </View>
        ))}
      </View>
    </BottomSheet>
  )
}

/** The header button that opens `open`'s `HeaderMenu`: spread `props` on its `IconButton` and give `outside` to
 * `HeaderMenu`'s `onPressOutside`. The menu's press outside closes it as a finger goes down on the button too (the
 * menu hangs from a 1 px anchor, so the button is outside it), so holding the button closes the menu; that finger
 * then does nothing as it lifts, and the next one opens the menu however soon it comes. One finger on the button runs
 * from the first of its touch start and press down (iOS sends the press down first, Android and headless the touch
 * start) to the first of its touch end, press up and touch cancel; its `onPress` comes after that, and the press
 * outside within it or, headless, after the `onPress`. Each finger starts afresh, so a tap outside or a cancelled
 * press leaves nothing for the next one, and an activation without a finger (an assistive technology's, a bare
 * `onPress`) toggles (WANG-121). */
export function menuButton(open: Signal<boolean>) {
  let down = false // a finger is on the button
  let closing = false // the press outside of the finger on the button, or the one that just left it, closed the menu
  const begin = () => { if (!down) { down = true; closing = false } }
  const end = () => { down = false }
  return {
    outside: () => { if (open()) { open.set(false); closing = true } },
    props: {
      onTouchStart: begin, onPressDown: begin,
      onTouchEnd: end, onPressUp: end, onTouchCancel: end,
      onPress: (e?: PressEvent) => {
        const consumed = !!e && closing
        closing = false
        if (!consumed) open.set(!open())
      },
    },
  }
}

/** A header's "⋯" menu, dropped under the button as Claude's app does: it grows from the corner (scale 0.8 → 1 with a
 * fade, Material 3's menu) in 150 ms and leaves faster. It hangs from the top right of the page's content, right under
 * the header: NSH lays out header buttons in the platform's toolbar, so a popup anchored to the button itself lands
 * elsewhere. The header button only toggles `open`. */
export function HeaderMenu(props: { open: () => boolean; onClose: () => void; actions: SheetAction[]; onChoose: (id: string) => void; onPressOutside?: (e: { pagePosition: Point }) => void }) {
  let anchor: ViewRef | undefined
  const shown = signal(false)
  coverWorkingText(shown)
  const m = createMotion({ initial: { opacity: 0, scale: 0.8 } })
  effect(() => {
    if (props.open()) { untracked(() => Keyboard.dismiss()); shown.set(true); m.play({ duration: 150, keyframes: [{ opacity: 0, scale: 0.8, easing: [0.05, 0.7, 0.1, 1] }, { opacity: 1, scale: 1 }] }) }
    else if (shown()) m.play({ duration: 100, keyframes: [{ opacity: 1, scale: 1, easing: [0.3, 0, 0.8, 0.15] }, { opacity: 0, scale: 0.9 }] }).then(() => { if (!props.open()) shown.set(false) })
  })
  const choose = (id: string) => { haptic('tick'); props.onClose(); props.onChoose(id) }
  return (
    <>
      <View ref={anchor} class="absolute top-0 right-[10px] w-[1px] h-[1px]" style={{ pointerEvents: 'none' }} />
      <If when={shown()}>
        <Overlay anchor={anchor} placement="bottom" align="end" offset={0} margin={8} onPressOutside={props.onPressOutside ?? props.onClose} onCancel={props.onClose}
          style={{ ...m.style, transformOrigin: 'top right' }} class="min-w-[200px] py-[6px] rounded-[14px] border border-border bg-popover shadow-lg" testID="header-menu">
          {props.actions.map((a) => (
            <View role="menuitem" testID={`menu-${a.id}`} onPress={() => choose(a.id)} class="flex-row items-center gap-3 px-[14px] h-[44px] active:bg-secondary transition-colors duration-150">
              {a.icon ? <Icon name={a.icon} size={18} class={a.destructive ? 'tint-destructive' : 'tint-foreground'} /> : null}
              <Text class={`text-[15px] ${a.destructive ? 'text-destructive' : 'text-foreground'}`}>{a.label}</Text>
            </View>
          ))}
        </Overlay>
      </If>
    </>
  )
}
