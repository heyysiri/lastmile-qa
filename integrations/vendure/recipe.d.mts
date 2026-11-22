export const VENDURE_REVISION: string;
export interface VendureRecipe {
    workingDirectory: string;
    installCommand: string;
    buildCommand: string;
    startCommand: string;
    port?: number;
    databasePath: string;
    runtimeFiles: string[];
}
export function prepareVendureRecipe(options: { workspace: string; port?: number }): VendureRecipe;
