// Test-only LD_PRELOAD logger for fork/tools/net-audit.sh: appends each
// getaddrinfo() name and connect() address to $NETLOG_OUT. Never installed.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static void logline(const char *kind, const char *what) {
	const char *path = getenv("NETLOG_OUT");
	if (!path) return;
	FILE *f = fopen(path, "a");
	if (!f) return;
	fprintf(f, "%d %s %s\n", getpid(), kind, what);
	fclose(f);
}

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
	static int (*real)(int, const struct sockaddr *, socklen_t);
	if (!real) real = dlsym(RTLD_NEXT, "connect");
	char buf[256] = "?";
	if (addr->sa_family == AF_INET) {
		const struct sockaddr_in *a = (const void *)addr;
		char ip[64];
		inet_ntop(AF_INET, &a->sin_addr, ip, sizeof ip);
		snprintf(buf, sizeof buf, "%s:%d", ip, ntohs(a->sin_port));
	} else if (addr->sa_family == AF_INET6) {
		const struct sockaddr_in6 *a = (const void *)addr;
		char ip[64];
		inet_ntop(AF_INET6, &a->sin6_addr, ip, sizeof ip);
		snprintf(buf, sizeof buf, "[%s]:%d", ip, ntohs(a->sin6_port));
	} else if (addr->sa_family == AF_UNIX) {
		snprintf(buf, sizeof buf, "unix:%s", ((const struct sockaddr_un *)addr)->sun_path);
	}
	logline("connect", buf);
	return real(fd, addr, len);
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
	static int (*real)(const char *, const char *, const struct addrinfo *, struct addrinfo **);
	if (!real) real = dlsym(RTLD_NEXT, "getaddrinfo");
	logline("resolve", node ? node : "(null)");
	return real(node, service, hints, res);
}
