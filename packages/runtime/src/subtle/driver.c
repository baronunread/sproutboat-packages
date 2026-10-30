/* Test driver for subtle.c: reads "op a b c d" lines (hex, "-" for empty), prints "rc hex". */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdint.h>
#include <bearssl.h>
#include "assembled.c"

static unsigned char* unhex(const char* s, size_t* n) {
  if (!strcmp(s, "-")) { *n = 0; return (unsigned char*)calloc(1, 1); }
  size_t l = strlen(s) / 2; unsigned char* o = (unsigned char*)malloc(l + 1);
  for (size_t i = 0; i < l; i++) { unsigned v; sscanf(s + 2 * i, "%2x", &v); o[i] = (unsigned char)v; }
  *n = l; return o;
}
int main(void) {
  static char line[1 << 20];
  while (fgets(line, sizeof line, stdin)) {
    char* t[5]; int k = 0;
    for (char* p = strtok(line, " \n"); p && k < 5; p = strtok(0, " \n")) t[k++] = p;
    if (k < 5) continue;
    size_t l[4]; unsigned char* a[4];
    for (int i = 0; i < 4; i++) a[i] = unhex(t[i + 1], &l[i]);
    unsigned char* out; size_t ol;
    int rc = sbc_op(atoi(t[0]), a[0], l[0], a[1], l[1], a[2], l[2], a[3], l[3], &out, &ol);
    printf("%d ", rc);
    for (size_t i = 0; i < ol; i++) printf("%02x", out[i]);
    printf("\n"); fflush(stdout);
    free(out); for (int i = 0; i < 4; i++) free(a[i]);
  }
  return 0;
}
