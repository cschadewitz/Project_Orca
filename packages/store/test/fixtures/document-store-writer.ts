// A child process that puts N documents into one collection file; see document-store-multiprocess.test.ts.
import { z } from "zod";
import { JsonFileDocumentStore } from "@orca/store";

const DocSchema = z.object({ id: z.string(), n: z.number() });
type Doc = z.infer<typeof DocSchema>;

const [file, prefix, count] = process.argv.slice(2) as [string, string, string];
const store = new JsonFileDocumentStore<Doc>(file, DocSchema);
for (let i = 0; i < Number(count); i++) await store.put({ id: `${prefix}${i}`, n: i });
