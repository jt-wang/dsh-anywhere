// Turns the hidden Progress page on (src/progress.tsx `progressPage`) before the app loads, for its tests.
import { progressPage } from '../../progress.tsx'
progressPage.enabled = true
