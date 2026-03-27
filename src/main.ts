import * as async from "std/async/mod.ts";
import * as fs from "std/fs/mod.ts";
import * as templates from "./templates.ts";
import * as djot from "./djot.ts";
import { HtmlString } from "./templates.ts";

async function main() {
  const params = {
    update: false,
    spell: false,
    profile: false,
    filter: "",
  };

  const subcommand = Deno.args[0];

  let i = 1;
  for (; i < Deno.args.length; i++) {
    switch (Deno.args[i]) {
      case "--update": {
        params.update = true;
        break;
      }
      case "--spell": {
        params.spell = true;
        break;
      }
      case "--profile": {
        params.profile = true;
        break;
      }
      case "--filter": {
        params.filter = Deno.args[i + 1] ?? "";
        i++;
        break;
      }
      default:
        fatal(`unexpected argument: ${Deno.args[i]}`);
    }
  }

  if (subcommand === "build") {
    await build(params);
  } else if (subcommand === "watch") {
    await watch(params);
  } else {
    fatal("subcommand required");
  }
}

function fatal(message: string): never {
  console.error(message);
  Deno.exit(1);
}

async function watch(params: { filter: string }) {
  let signal = async.deferred();
  (async () => {
    let build_id = 0;
    while (await signal) {
      signal = async.deferred();
      console.log(`rebuild #${build_id}`);
      build_id += 1;
      await build({
        update: true,
        spell: false,
        profile: false,
        filter: params.filter,
      });
    }
  })();

  signal.resolve(true);

  const rebuild_debounced = async.debounce(
    () => signal.resolve(true),
    16,
  );

  for await (const event of Deno.watchFs("./content", { recursive: true })) {
    if (event.kind == "access") continue;
    await rebuild_debounced();
  }
  signal.resolve(false);
}

class Ctx {
  constructor(
    public read_ms: number = 0,
    public parse_ms: number = 0,
    public render_ms: number = 0,
    public collect_ms: number = 0,
    public total_ms: number = 0,
  ) {}
}

async function build(params: {
  update: boolean;
  spell: boolean;
  profile: boolean;
  filter: string;
}) {
  const t = performance.now();

  const ctx = new Ctx();
  if (params.update) {
    await Deno.mkdir("./out/res", { recursive: true });
  } else {
    await fs.emptyDir("./out/res");
  }

  const { blogs, others } = await collect_posts(ctx, params.filter);
  await update_file("out/res/index.html", templates.post_list(blogs).value);
  await update_file("out/res/feed.xml", templates.feed(blogs).value);
  for (const post of [...blogs, ...others]) {
    await update_file(
      `out/res${post.path}`,
      templates.post(post, params.spell).value,
    );
  }

  const pages = ["about", "shortcuts", "readings"];
  // const pages = ["about", "resume", "links", "style"];
  for (const page of pages) {
    const text = await Deno.readTextFile(`content/${page}.dj`);
    const ast = await djot.parse(text);
    const html = djot.render(ast, {});
    await update_file(`out/res/${page}.html`, templates.page(page, html).value);
  }

  const paths = [
    "favicon.svg",
    "favicon.png",
    // "resume.pdf",
    "css/*",
    "assets/*",
    // "assets/resilient-parsing/*",
  ];
  for (const path of paths) {
    await update_path(path);
  }

  ctx.total_ms = performance.now() - t;
  console.log(`${ctx.total_ms}ms`);
  if (params.profile) console.log(JSON.stringify(ctx));
}

async function update_file(path: string, content: Uint8Array | string) {
  if (!content) return;
  await fs.ensureFile(path);
  await fs.ensureDir("./build");
  const temp = await Deno.makeTempFile({ dir: "./build" });
  if (content instanceof Uint8Array) {
    await Deno.writeFile(temp, content);
  } else {
    await Deno.writeTextFile(temp, content);
  }
  await Deno.rename(temp, path);
}

async function update_path(path: string) {
  if (path.endsWith("*")) {
    const dir = path.replace("*", "");
    const futs = [];
    for await (const entry of Deno.readDir(`content/${dir}`)) {
      if (entry.isFile) {
        futs.push(update_path(`${dir}/${entry.name}`));
      }
    }
    await Promise.all(futs);
  } else {
    await update_file(
      `out/res/${path}`,
      await Deno.readFile(`content/${path}`),
    );
  }
}

export type Post = {
  kind: PostKind;
  category?: string;
  slug: string;
  title: string;
  path: string;
  src: string;
  content: HtmlString;
  summary: string;
};

export enum PostKind {
  Blog = "blog",
  Custom = "custom",
}

export type BlogPost = Post & {
  kind: PostKind.Blog;
  year: number;
  month: number;
  day: number;
  date: Date;
};

type CollectedPosts = {
  blogs: BlogPost[];
  others: Post[];
};

async function collect_posts(
  ctx: Ctx,
  filter: string,
): Promise<CollectedPosts> {
  const start = performance.now();
  const blogs: BlogPost[] = [];
  const others: Post[] = [];
  for await (
    const entry of fs.walk("./content/posts", { includeDirs: false })
  ) {
    if (!entry.name.endsWith(".dj")) continue;
    if (filter !== "") {
      if (entry.name.indexOf(filter) === -1) continue;
    }
    const normalized_path = normalize_path(entry.path);
    const rel = normalized_path
      .replace(/^\.\//, "")
      .replace(/^content\/posts\//, "");
    const src = `/${normalized_path.replace(/^\.\//, "")}`;

    const blog = parse_blog_info(rel);
    const category = blog ? undefined : parse_other_category(rel);
    const kind = blog
      ? PostKind.Blog
      : category
      ? PostKind.Custom
      : undefined;

    if (!kind) {
      fatal(`unsupported post path: ${entry.path}`);
    }

    const route_kind = route_segment(kind, category);
    const category_path = category ?? "";
    const path = blog
      ? `/${blog.y}/${blog.m}/${blog.d}/${blog.slug}.html`
      : `/${route_kind}/${without_ext(rel.replace(`${category_path}/`, ""))}.html`;

    let t = performance.now();
    const text = await Deno.readTextFile(entry.path);
    ctx.read_ms += performance.now() - t;

    t = performance.now();
    const ast = djot.parse(text);
    ctx.parse_ms += performance.now() - t;

    t = performance.now();
    const render_ctx = {
      date: blog
        ? new Date(Date.UTC(blog.year, blog.month - 1, blog.day))
        : undefined,
      summary: undefined,
      title: undefined,
    };
    const html = djot.render(ast, render_ctx);
    ctx.render_ms += performance.now() - t;

    const post: Post = {
      kind,
      category,
      slug: blog ? blog.slug : without_ext(entry.name),
      title: render_ctx.title!,
      content: html,
      summary: render_ctx.summary!,
      path,
      src,
    };

    if (kind === PostKind.Blog) {
      blogs.push({
        ...post,
        kind: PostKind.Blog,
        year: blog!.year,
        month: blog!.month,
        day: blog!.day,
        date: render_ctx.date!,
      });
    } else {
      others.push(post);
    }
  }
  blogs.sort((l, r) => l.path < r.path ? 1 : -1);
  others.sort((l, r) => l.path > r.path ? 1 : -1);
  ctx.collect_ms = performance.now() - start;
  return { blogs, others };
}

function normalize_path(path: string): string {
  return path.replaceAll("\\", "/");
}

function without_ext(name: string): string {
  return name.endsWith(".dj") ? name.slice(0, -3) : name;
}

function parse_blog_info(rel: string):
  | { year: number; month: number; day: number; y: string; m: string; d: string; slug: string }
  | undefined {
  const match = rel.match(/^(\d\d\d\d)-(\d\d)-(\d\d)-(.*)\.dj$/);
  if (!match) return undefined;
  const [, y, m, d, slug] = match;
  const [year, month, day] = [y, m, d].map((it) => parseInt(it, 10));
  return { year, month, day, y, m, d, slug };
}

function parse_other_category(rel: string): string | undefined {
  const m = rel.match(/^([a-zA-Z0-9_-]+)\/.+\.dj$/);
  return m?.[1];
}

function route_segment(kind: PostKind, category?: string): string {
  if (kind === PostKind.Custom && category) return category;
  return PostKind.Blog;
}

if (import.meta.main) await main();
