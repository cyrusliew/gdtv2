import { defineConfig } from "tinacms";
import { MediaUploadField } from "./MediaUploadField";

// Your hosting provider likely exposes this as an environment variable
const branch =
  process.env.GITHUB_BRANCH ||
  process.env.VERCEL_GIT_COMMIT_REF ||
  process.env.HEAD ||
  "main";

const ACCEPTED_TV_MEDIA = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "mp4",
  "webm",
  "mov",
] as const;

export default defineConfig({
  branch,
  // Get this from tina.io
  clientId: process.env.NEXT_PUBLIC_TINA_CLIENT_ID,
  // Get this from tina.io
  token: process.env.TINA_TOKEN,

  build: {
    outputFolder: "admin",
    publicFolder: "public",
  },
  media: {
    loadCustomStore: async () => {
      const pack = await import("./R2MediaStore");
      return pack.R2MediaStore;
    },
  },
  // See docs on content modeling for more info on how to setup new content models: https://tina.io/docs/r/content-modelling-collections/
  schema: {
    collections: [
      {
        name: "tv",
        label: "TV Settings",
        path: "src/data",
        match: {
          include: "tv*",
        },
        format: "json",
        fields: [
          {
            name: "useR2",
            label: "Serve Media from Cloudflare R2",
            type: "boolean",
            description:
              "ON: serve media from Cloudflare R2. OFF: mirror media into /assets/local/ during build and serve from static hosting (GitHub Pages).",
          },
          {
            name: "slides",
            label: "Slides",
            type: "object",
            list: true,
            ui: {
              itemProps: (item) => ({
                label: item?.id,
              }),
            },
            fields: [
              { name: "id", label: "ID", type: "string", required: true },
              {
                name: "src",
                label: "Media (Image or Video)",
                type: "image",
                required: true,
                accept: [...ACCEPTED_TV_MEDIA],
                description:
                  "Auto-detects images (JPG, PNG, WebP, GIF) and videos (MP4 H.264, WebM, MOV). Video duration is auto-detected on upload.",
                ui: {
                  component: MediaUploadField,
                },
              },
              {
                name: "duration",
                label: "Duration (sec)",
                type: "number",
                description:
                  "Display duration in seconds. Auto-filled for videos (or defaults to 10s for images if left empty). Ensure total playlist durations across synced TVs match for lockstep alignment.",
              },
              {
                name: "videoBehavior",
                label: "Video End Behavior",
                type: "string",
                description:
                  "Only applies when a video is shorter than the slide duration.",
                options: [
                  { value: "loop", label: "Loop seamlessly (default)" },
                  { value: "hold", label: "Freeze on last frame" },
                ],
              },
              { name: "note", label: "Note", type: "string" },
              {
                name: "unpublish",
                label: "Unpublish",
                type: "boolean",
                description: "Hide this slide from the live TV rotation",
              },
              {
                name: "syncGroup",
                label: "Sync Group / Campaign ID",
                type: "string",
                description:
                  "Optional identifier (e.g. 'harry-potter-takeover') to tag slides that participate in multi-screen synced takeovers.",
              },
            ],
          },
        ],
      },
      {
        name: "takeover",
        label: "Multi-Screen Takeovers",
        path: "src/data/takeovers",
        format: "json",
        fields: [
          {
            name: "title",
            label: "Campaign Title",
            type: "string",
            isTitle: true,
            required: true,
          },
          {
            name: "duration",
            label: "Duration (sec)",
            type: "number",
            description:
              "Unified display duration on all screens in seconds. Auto-filled from the longest uploaded video (or defaults to 15s for images if left empty).",
          },
          {
            name: "videoBehavior",
            label: "Video End Behavior",
            type: "string",
            description:
              "When a screen's takeover video is shorter than the takeover duration.",
            options: [
              { value: "loop", label: "Loop seamlessly (default)" },
              { value: "hold", label: "Freeze on last frame" },
            ],
          },
          {
            name: "tv1Media",
            label: "TV 1 Media Asset (Optional)",
            type: "image",
            accept: [...ACCEPTED_TV_MEDIA],
            ui: { component: MediaUploadField },
          },
          {
            name: "tv2Media",
            label: "TV 2 Media Asset (Optional)",
            type: "image",
            accept: [...ACCEPTED_TV_MEDIA],
            ui: { component: MediaUploadField },
          },
          {
            name: "tv3Media",
            label: "TV 3 Media Asset (Optional)",
            type: "image",
            accept: [...ACCEPTED_TV_MEDIA],
            ui: { component: MediaUploadField },
          },
          {
            name: "tv4Media",
            label: "TV 4 Media Asset (Optional)",
            type: "image",
            accept: [...ACCEPTED_TV_MEDIA],
            ui: { component: MediaUploadField },
          },
          {
            name: "unpublish",
            label: "Unpublish",
            type: "boolean",
            description: "Hide this takeover from rotation on all TVs",
          },
        ],
      },
    ],
  },
});
