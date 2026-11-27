import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

function ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

type PickResult = { path: string | null; canceled: boolean };

// AppleScript 문자열 리터럴. 경로에 따옴표/역슬래시가 있어도 깨지지 않게 한다.
function appleScriptString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// 선택기가 취소된 경우와 도구 자체가 없는 경우를 구분한다.
// 취소는 즉시 null로 끝내고, 도구가 없을 때만 직접 입력으로 폴백한다.
function isCanceled(error: unknown): boolean {
    const err = error as { status?: number; stderr?: string | Buffer; message?: string };
    const text = `${err.stderr ?? ""} ${err.message ?? ""}`;
    return /-128|user canceled|user cancelled/i.test(text);
}

// macOS: 앞에 있는 앱에게 시키지 않고 Finder를 활성화한 뒤 직접 띄운다.
function pickDarwin(start: string): PickResult | null {
    try {
        const out = execFileSync(
            "osascript",
            [
                "-e",
                'tell application "Finder" to activate',
                "-e",
                `POSIX path of (choose folder with prompt "Pick a folder" default location (POSIX file ${appleScriptString(start)}))`,
            ],
            { timeout: 120000, encoding: "utf8" },
        ).trim();
        if (out && existsSync(out)) {
            return { path: out.replace(/\/$/, ""), canceled: false };
        }
        return { path: null, canceled: false };
    } catch (error) {
        if (isCanceled(error)) {
            return { path: null, canceled: true };
        }
        return null;
    }
}

function pickWindows(start: string): PickResult | null {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = '${start.replace(/'/g, "''")}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`;
    try {
        const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], {
            timeout: 120000,
            encoding: "utf8",
        }).trim();
        if (out.length > 0) {
            return { path: out, canceled: false };
        }
        // 빈 출력은 취소다.
        return { path: null, canceled: true };
    } catch {
        return null;
    }
}

function pickLinux(start: string): PickResult | null {
    const candidates: string[][] = [
        ["zenity", "--file-selection", "--directory", "--title=Pick a folder", `--filename=${start}/`],
        ["kdialog", "--getexistingdirectory", start],
    ];
    for (const argv of candidates) {
        try {
            const out = execFileSync(argv[0], argv.slice(1), { timeout: 120000, encoding: "utf8" }).trim();
            if (out && existsSync(out)) {
                return { path: out, canceled: false };
            }
            return { path: null, canceled: false };
        } catch (error) {
            const status = (error as { status?: number }).status;
            if (isCanceled(error) || status === 1) {
                // zenity/kdialog는 취소 시 exit 1을 준다.
                return { path: null, canceled: true };
            }
            // 도구가 없으면 다음 후보
        }
    }
    return null;
}

// OS 기본 폴더 선택. 터미널이 띄우고 경로를 받아온다.
// 취소하면 null, 도구를 못 쓰면 직접 입력으로 폴백한다.
export async function pickDirectory(startDir?: string | null): Promise<string | null> {
    if (!process.stdin.isTTY) {
        return null;
    }
    const start = startDir ?? join(homedir(), "Projects");
    const plat = platform();
    const result = plat === "darwin" ? pickDarwin(start) : plat === "win32" ? pickWindows(start) : pickLinux(start);
    if (result) {
        return result.path;
    }
    const typed = await ask(`Folder path [${start}]: `);
    const dir = typed.length > 0 ? typed : start;
    return dir;
}

export function isDir(path: string): boolean {
    try {
        return existsSync(path) && statSync(path).isDirectory();
    } catch {
        return false;
    }
}

export async function askTyped(question: string): Promise<string> {
    if (!process.stdin.isTTY) {
        return "";
    }
    return ask(question);
}
