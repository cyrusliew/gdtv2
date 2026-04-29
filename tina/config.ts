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
        name: "post",
        label: "Posts",
        path: "content/posts",
        fields: [
          {
            type: "string",
            name: "title",
            label: "Title",
            isTitle: true,
            required: true,
          },
          {
            type: "rich-text",
            name: "body",
            label: "Body",
            isBody: true,
          },
        ],
      },
      {
        name: "tv",
        label: "TV Settings",
        path: "src/data",
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
              {
                name: "type",
                label: "Type",
                type: "string",
                options: ["image", "video"]
              },
              { name: "src", label: "Media", type: "image", required: true },
              {
                name: "duration",
                label: "Duration (sec)",
                type: "number"
              },
              { name: "note", label: "Note", type: "string" },
              {
                name: "unpublish",
                label: "Unpublish",
                type: "boolean",
                description: "Hide this slide from the live TV rotation",
              }
            ]
          }
        ],
      },
    ],
  },
});
