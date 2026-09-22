/** Windows local workspaces and POSIX remote workspaces share conservative path matching. */
import { expect, it } from "vitest";
import { normalizePermissionPath, permissionPathForms, workspaceRelativePath } from "@orca/core";

it("makes drive-rooted paths relative only within the same workspace", () => {
  expect(permissionPathForms("c:\\work\\src\\a.ts", "C:\\work")).toEqual(["C:/work/src/a.ts", "src/a.ts"]);
  expect(workspaceRelativePath("C:/workmate/file", "C:/work")).toBeUndefined();
  expect(workspaceRelativePath("D:/work/file", "C:/work")).toBeUndefined();
  expect(workspaceRelativePath("C:relative", "C:/work")).toBeUndefined();
  expect(workspaceRelativePath("C:/work/../secret", "C:/work")).toBeUndefined();
});

it("recognizes UNC roots while preserving POSIX backslashes as filename characters", () => {
  expect(workspaceRelativePath("\\\\server\\share\\work\\file", "\\\\server\\share\\work")).toBe("file");
  expect(workspaceRelativePath("\\\\other\\share\\work\\file", "\\\\server\\share\\work")).toBeUndefined();
  expect(normalizePermissionPath("/work/a\\b")).toBe("/work/a\\b");
});
