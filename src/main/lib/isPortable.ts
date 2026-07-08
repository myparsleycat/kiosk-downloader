export function isPortable() {
    return (
        process.env.PORTABLE_EXECUTABLE_DIR != null && process.env.PORTABLE_EXECUTABLE_DIR !== ""
    );
}
