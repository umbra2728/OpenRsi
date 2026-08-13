Build a complete, self-contained high-accuracy CUDA solver for the two-dimensional heat equation in this empty workspace. You may choose the implementation language, discretization, dependencies, build system, and CUDA libraries that best fit the task.

The deliverable must run non-interactively as `./run.sh <config.json> <output_dir>`. Its numerical workload must execute on the visible NVIDIA CUDA GPU (compute capability 8.6) in double precision; CPU-only fallback or merely detecting CUDA is not acceptable. Use a manufactured sine-mode solution with Dirichlet boundary conditions so accuracy can be verified independently.

Report relative L2 error against the analytical solution, parity error against an independent CPU/reference solution on a small grid, observed convergence when spatial resolution doubles, boundary error, CUDA device count/name, proof that the workload ran in a CUDA process, absence of NaN/Inf, and determinism across two identical runs. Targets are relative L2 <= 1e-5 and CPU parity <= 1e-8.

Use the unit square, initial condition `u(x,y,0)=sin(pi*x)*sin(pi*y)`, and exact solution `exp(-2*pi^2*alpha*t)*sin(pi*x)*sin(pi*y)`. `solution.npz` must contain float64 arrays `x [nx]`, `y [ny]`, and final numerical solution `u [ny,nx]` at `final_time`, including boundary points.

Write `output/metrics.json`, `output/solution.npz`, `output/heatmap.png`, and `output/heatmap.mp4`. Include tests and concise build/run documentation. Run the implementation as `./run.sh config.json output` and run its tests yourself, inspect failures, and iterate until the contract passes. Do not ask the user questions; make sound engineering choices autonomously.
