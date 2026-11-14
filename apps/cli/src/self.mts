// How to start this CLI again: the dispatcher starts workers with it, and a worker starts its hook with it.

// Step 4 of the CLI polish decides this from the runtime of the compiled binary.
function isCompiledBinary(): boolean {
  return false;
}

export function selfCommand(...args: string[]): string[] {
  if (isCompiledBinary()) return [process.execPath, ...args];
  return [process.execPath, process.argv[1] ?? '', ...args];
}
