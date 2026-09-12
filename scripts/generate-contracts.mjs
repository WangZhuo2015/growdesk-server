import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCanonicalOpenApi } from "./contract-generator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "contracts");
const outputFile = path.join(outputDir, "openapi.json");

async function main() {
  console.log("Generating canonical OpenAPI 3.0.3 specification from @growdesk/contracts...");
  const spec = await generateCanonicalOpenApi();

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputFile, JSON.stringify(spec, null, 2) + "\n", "utf8");

  const paths = Object.keys(spec.paths || {}).length;
  let operations = 0;
  for (const pathItem of Object.values(spec.paths || {})) {
    for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
      if (pathItem[method]) operations++;
    }
  }
  const schemas = Object.keys(spec.components?.schemas || {}).length;

  console.log(`Successfully generated ${outputFile}`);
  console.log(`- OpenAPI version: ${spec.openapi}`);
  console.log(`- Path count: ${paths}`);
  console.log(`- Operation count: ${operations}`);
  console.log(`- Schema component count: ${schemas}`);
}

main().catch((err) => {
  console.error("Contract generation failed:", err);
  process.exit(1);
});
