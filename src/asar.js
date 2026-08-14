import { listPackage, extractAll, createPackage } from "@electron/asar";

export function list(archivePath) {
    return listPackage(archivePath);
}

export function extract(archivePath, destDir) {
    return extractAll(archivePath, destDir);
}

export async function pack(srcDir, destArchive) {
    return createPackage(srcDir, destArchive);
}
