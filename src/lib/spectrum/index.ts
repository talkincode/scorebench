import type { SpectrumStyle } from "./types";
import { bars } from "./bars";
import { loopring } from "./loopring";
import { spectrogram } from "./spectrogram";
import { wave } from "./wave";

export type { SpectrumFrame, SpectrumOptionDefinition, SpectrumStyle } from "./types";
export { drawWithFallback } from "./runtime";

/** Registry consumed by the player's style picker; add styles only here. */
export const spectrumStyles: SpectrumStyle[] = [bars, wave, spectrogram, loopring];
