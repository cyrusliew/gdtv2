import { defineConfig } from "tinacms";

// Your hosting provider likely exposes this as an environment variable
const branch =
  process.env.GITHUB_BRANCH ||
  process.env.VERCEL_GIT_COMMIT_REF ||
  process.env.HEAD ||
  "main";

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
    tina: {
      mediaRoot: "assets",
      publicFolder: "public",
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
              { name: "src", label: "Media", type: "image", required: true },
              {
                name: "duration",
                label: "Duration (sec)",
                type: "number",
                description: "Display duration in seconds (defaults to 10s if left empty). Ensure total playlist duration across synced TVs match for lockstep alignment.",
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
                description: "Optional identifier (e.g. 'harry-potter-takeover') to tag slides that participate in multi-screen synced takeovers.",
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
            description: "Display duration on all screens in seconds (defaults to 15s if left empty)",
          },
          {
            name: "tv1Media",
            label: "TV 1 Media Asset (Optional)",
            type: "image",
          },
          {
            name: "tv2Media",
            label: "TV 2 Media Asset (Optional)",
            type: "image",
          },
          {
            name: "tv3Media",
            label: "TV 3 Media Asset (Optional)",
            type: "image",
          },
          {
            name: "tv4Media",
            label: "TV 4 Media Asset (Optional)",
            type: "image",
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
