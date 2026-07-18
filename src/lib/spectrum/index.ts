import type { SpectrumStyle } from "./types";
import { bars } from "./bars";
import { wave } from "./wave";

export type { SpectrumStyle };

/** Registry consumed by the player's style picker; extend by appending. */
export const spectrumStyles: SpectrumStyle[] = [bars, wave];
