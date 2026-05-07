import z from "zod";
import { TrackSchema } from "@x/shared/dist/track.js";

export const TrackStateSchema = z.object({
    track: TrackSchema,
});
