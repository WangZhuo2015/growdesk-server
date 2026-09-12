const command = process.argv[2] ?? "requested command";
const task = process.argv[3] ?? "a later implementation task";

console.error(`${command} is not implemented in this baseline; it is owned by ${task}.`);
process.exitCode = 2;
