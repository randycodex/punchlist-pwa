export function getAreaReturnPath(projectId: string, returnToHome: boolean) {
  return returnToHome ? '/' : `/project/${projectId}`;
}
