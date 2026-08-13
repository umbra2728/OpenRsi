#!/usr/bin/env bash
set -euo pipefail
docker run --rm --gpus device=0 harnessblog/base:cuda12.8 bash -lc '
cat >/tmp/smoke.cu <<"CUDA"
#include <cstdio>
__global__ void add(double *x) { x[threadIdx.x] += 1.0; }
int main() {
  double h[1] = {41.0}, *d;
  cudaMalloc(&d, sizeof(double));
  cudaMemcpy(d, h, sizeof(double), cudaMemcpyHostToDevice);
  add<<<1,1>>>(d);
  cudaMemcpy(h, d, sizeof(double), cudaMemcpyDeviceToHost);
  cudaFree(d);
  std::printf("%.1f\n", h[0]);
  return h[0] == 42.0 ? 0 : 1;
}
CUDA
nvcc -arch=sm_86 /tmp/smoke.cu -o /tmp/smoke && /tmp/smoke
'

