/**
 * fork: the seccomp filter given to bubblewrap (`--seccomp <fd>`), written as classic BPF
 * without a dependency. It refuses the system calls that open a way out of the sandbox or up in
 * privileges, and Unix sockets: the session and system
 * buses, the keyring, Docker and X11 all listen on one. `socketpair`, which Python and Node use
 * internally, stays allowed for stream and seqpacket pairs only. Syscall numbers come from the kernel headers (asm/unistd_64.h and
 * asm-generic/unistd.h, the arm64 table), checked on 2026-10-21.
 */

export type SeccompArch = "x64" | "arm64";

interface ArchTable {
	audit: number;
	socket: number;
	socketpair: number;
	ioctl: number;
	clone: number;
	denied: number[];
}

const BOTH = {
	clone3: 435,
	newMount: [428, 429, 430, 431, 432, 433, 442, 467], // open_tree, move_mount, fsopen..fspick, mount_setattr, open_tree_attr
	ioUring: [425, 426, 427],
};

const TABLES: Record<SeccompArch, ArchTable> = {
	x64: {
		audit: 0xc000003e,
		socket: 41,
		socketpair: 53,
		ioctl: 16,
		clone: 56,
		// unshare, setns, ptrace, process_vm_readv/writev, keyctl, add_key, request_key, bpf, perf_event_open,
		// mount, umount2, pivot_root, kexec_load, kexec_file_load, init/finit/delete_module, userfaultfd
		denied: [272, 308, 101, 310, 311, 250, 248, 249, 321, 298, 165, 166, 155, 246, 320, 175, 313, 176, 323],
	},
	arm64: {
		audit: 0xc00000b7,
		socket: 198,
		socketpair: 199,
		ioctl: 29,
		clone: 220,
		denied: [97, 268, 117, 270, 271, 219, 217, 218, 280, 241, 40, 39, 41, 104, 294, 105, 273, 106, 282],
	},
};

const AF_INET = 2;
const AF_INET6 = 10;
const AF_NETLINK = 16;
const SOCK_STREAM = 1;
const SOCK_SEQPACKET = 5;
/** The socket type without SOCK_NONBLOCK and SOCK_CLOEXEC. */
const SOCK_TYPE_MASK = 0xf;
const TIOCSTI = 0x5412;
const TIOCLINUX = 0x541c;
/** CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET | NEWTIME */
const CLONE_NEW_NAMESPACES = 0x7e020080;
/** x32 system calls on x86_64 have this bit; they are refused. */
const X32_SYSCALL_BIT = 0x40000000;

const EPERM = 1;
const ENOSYS = 38;
const RET_ALLOW = 0x7fff0000;
const RET_ERRNO = 0x00050000;
const RET_KILL_PROCESS = 0x80000000;

// struct seccomp_data: nr (u32) at 0, arch (u32) at 4, args (u64, little endian) from 16.
const NR = 0;
const ARCH = 4;
const argLow = (index: number) => 16 + 8 * index;

const LD_ABS = 0x20;
const JEQ = 0x15;
const JGE = 0x35;
const JSET = 0x45;
const RET = 0x06;
const AND = 0x54; // BPF_ALU | BPF_AND | BPF_K

type Target = string | null; // a label, or null for the next instruction
type Instruction = { code: number; k: number; jt?: Target; jf?: Target; label?: string };

/**
 * The filter as `struct sock_filter[]` bytes, for bubblewrap's `--seccomp`. Unix sockets are always refused:
 * reopening them for the system bus opened every socket of the machine, one of which runs commands outside the
 * sandbox (sandbox.md § 8.3).
 *
 * fork: `socket` takes a list of allowed families, IPv4, IPv6 and netlink (the
 * C library asks it for the addresses of the network namespace before resolving a name); every other family is
 * refused. The network namespace separates IP only: an `AF_VSOCK` socket reached the machine's own vsock services,
 * its virtual machines, and the host when Prism runs in one, without the proxy.
 */
export function seccompFilter(arch: SeccompArch): Buffer {
	const table = TABLES[arch];
	const program: Instruction[] = [
		{ code: LD_ABS, k: ARCH },
		// Another architecture's numbers mean other calls: refuse everything rather than misread them.
		{ code: JEQ, k: table.audit, jt: null, jf: "kill" },
		{ code: LD_ABS, k: NR },
		...(arch === "x64" ? [{ code: JGE, k: X32_SYSCALL_BIT, jt: "eperm", jf: null }] : []),
		...[...table.denied, ...BOTH.newMount, ...BOTH.ioUring].map((nr) => ({
			code: JEQ,
			k: nr,
			jt: "eperm",
			jf: null,
		})),
		{ code: JEQ, k: table.socket, jt: "socket", jf: null },
		{ code: JEQ, k: table.socketpair, jt: "socketpair", jf: null },
		{ code: JEQ, k: table.ioctl, jt: "ioctl", jf: null },
		{ code: JEQ, k: table.clone, jt: "clone", jf: null },
		// clone3 passes its flags in memory, out of the filter's sight: ENOSYS makes libc fall back to clone.
		{ code: JEQ, k: BOTH.clone3, jt: "enosys", jf: "allow" },
		{ label: "socket", code: LD_ABS, k: argLow(0) },
		{ code: JEQ, k: AF_INET, jt: "allow", jf: null },
		{ code: JEQ, k: AF_INET6, jt: "allow", jf: null },
		{ code: JEQ, k: AF_NETLINK, jt: "allow", jf: "eperm" },
		// A datagram end (SOCK_DGRAM, or SOCK_RAW which AF_UNIX turns into one) can be connected again to a
		// host socket on a visible path; a connected stream or seqpacket end cannot.
		{ label: "socketpair", code: LD_ABS, k: argLow(1) },
		{ code: AND, k: SOCK_TYPE_MASK },
		{ code: JEQ, k: SOCK_STREAM, jt: "allow", jf: null },
		{ code: JEQ, k: SOCK_SEQPACKET, jt: "allow", jf: "eperm" },
		{ label: "ioctl", code: LD_ABS, k: argLow(1) },
		{ code: JEQ, k: TIOCSTI, jt: "eperm", jf: null },
		{ code: JEQ, k: TIOCLINUX, jt: "eperm", jf: "allow" },
		{ label: "clone", code: LD_ABS, k: argLow(0) },
		{ code: JSET, k: CLONE_NEW_NAMESPACES, jt: "eperm", jf: "allow" },
		{ label: "eperm", code: RET, k: RET_ERRNO | EPERM },
		{ label: "enosys", code: RET, k: RET_ERRNO | ENOSYS },
		{ label: "allow", code: RET, k: RET_ALLOW },
		{ label: "kill", code: RET, k: RET_KILL_PROCESS },
	];
	const labels = new Map(
		program.flatMap((instruction, index) => (instruction.label ? [[instruction.label, index]] : [])),
	);
	const offset = (from: number, target: Target | undefined) => {
		if (target === undefined || target === null) return 0;
		const to = labels.get(target);
		if (to === undefined || to <= from || to - from - 1 > 255) throw new Error(`bad seccomp jump to ${target}`);
		return to - from - 1;
	};
	const bytes = Buffer.alloc(program.length * 8);
	program.forEach((instruction, index) => {
		bytes.writeUInt16LE(instruction.code, index * 8);
		bytes.writeUInt8(offset(index, instruction.jt), index * 8 + 2);
		bytes.writeUInt8(offset(index, instruction.jf), index * 8 + 3);
		bytes.writeUInt32LE(instruction.k >>> 0, index * 8 + 4);
	});
	return bytes;
}

export function seccompArch(arch = process.arch): SeccompArch | undefined {
	return arch === "x64" || arch === "arm64" ? arch : undefined;
}
