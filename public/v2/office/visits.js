// Visits are decided by the OfficeVM. The browser consumes these flags only to
// animate the scene; it does not inspect exchanges or infer visitor state.
export function visitsFromOfficeVM(vm) {
  return vm?.visitIntent ?? null;
}
