// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Test-only (the routine-probe feature): runs the routines swap-routines.sh replaces, and kernel code that calls
// them, on fixed inputs. Values come back in a form that does not depend on choices the math leaves open (sorted
// singular values, vectors with their largest entry positive), so tests/routines.rs can hold them against the
// values the kernel's original routines gave (tests/routines.golden.json). Names starting "check." are residuals
// that must be near zero, whichever routines ran.
#include "json.h"

#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmBrep.h>
#include <SmMatrix.h>
#include <nurbs.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <vector>

using sxj::Value;

namespace {

Value out = Value::object();

void put(const std::string& name, const std::vector<double>& v)
{
    Value a = Value::array();
    for (double d : v) a.push(d);
    out.set(name, a);
}

// a vector up to sign: its largest entry made positive
std::vector<double> signless(std::vector<double> v)
{
    size_t k = 0;
    for (size_t i = 1; i < v.size(); i++)
        if (std::fabs(v[i]) > std::fabs(v[k]) + 1e-12) k = i;
    if (!v.empty() && v[k] < 0)
        for (double& d : v) d = -d;
    return v;
}

// deterministic entries in [-1, 1)
struct Lcg {
    unsigned long long s;
    double next()
    {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return double(s >> 11) / double(1ULL << 52) - 1.0;
    }
};

struct Rows {
    std::vector<double> store;
    std::vector<double*> rows;
    Rows(int r, int c) : store(size_t(r) * c, 0.0), rows(r)
    {
        for (int i = 0; i < r; i++) rows[i] = &store[size_t(i) * c];
    }
    double** p() { return rows.data(); }
};

std::vector<std::vector<double>> cases()
{
    // row-major, first two entries are the size
    std::vector<std::vector<double>> c;
    c.push_back({4, 3, 1, 2, 3, 4, 5, 6, 7, 8, 10, 2, 1, 0});
    c.push_back({4, 3, 1, 2, 3, 4, 5, 9, 7, 8, 15, 2, 1, 3}); // third column = first + second
    c.push_back({3, 3, 2, 0, 0, 0, 1e-3, 0, 0, 0, 1});
    c.push_back({6, 2, 1, 1, 1, 2, 1, 3, 1, 4, 1, 5, 1, 6});
    Lcg g{7};
    std::vector<double> r{5, 5};
    for (int i = 0; i < 25; i++) r.push_back(g.next());
    c.push_back(r);
    return c;
}

void svd_cases()
{
    auto all = cases();
    for (size_t k = 0; k < all.size(); k++) {
        const auto& c = all[k];
        int m = int(c[0]), n = int(c[1]);
        std::string tag = std::to_string(k);
        // NLib form: highest indices
        Rows A(m, n), V(n, n);
        for (int i = 0; i < m * n; i++) A.p()[i / n][i % n] = c[2 + i];
        std::vector<double> W(n);
        int flag = N_RealMatrixSingleValueDecompose(A.p(), W.data(), V.p(), m - 1, n - 1);
        put("svd.nl." + tag + ".flag", {double(flag)});
        double rec = 0, ortho = 0;
        for (int i = 0; i < m; i++)
            for (int j = 0; j < n; j++) {
                double s = 0;
                for (int l = 0; l < n; l++) s += A.p()[i][l] * W[l] * V.p()[j][l];
                rec = std::max(rec, std::fabs(s - c[2 + i * n + j]));
            }
        for (int p = 0; p < n; p++)
            for (int q = 0; q < n; q++) {
                double s = 0, t = 0;
                for (int i = 0; i < m; i++) s += A.p()[i][p] * A.p()[i][q];
                for (int i = 0; i < n; i++) t += V.p()[i][p] * V.p()[i][q];
                ortho = std::max({ortho, std::fabs(s - (p == q)), std::fabs(t - (p == q))});
            }
        put("check.svd.nl." + tag + ".reconstruct", {rec});
        put("check.svd.nl." + tag + ".orthonormal", {ortho});
        std::vector<double> sorted(W);
        std::sort(sorted.rbegin(), sorted.rend());
        put("svd.nl." + tag + ".w", sorted);

        // least squares through the decomposition, singular values edited by the routine
        std::vector<double> rhs(m), x(n);
        for (int i = 0; i < m; i++) rhs[i] = 1.0 + i * 0.5 - (i % 2) * 0.25;
        flag = N_SingleValueDecomposeSolve(A.p(), W.data(), V.p(), m - 1, n - 1, rhs.data(), NL_RVALUE, NL_YES, x.data());
        put("svdsolve.nl." + tag + ".flag", {double(flag)});
        put("svdsolve.nl." + tag + ".x", x);
        std::vector<NL_POINT> pts(m);
        for (int i = 0; i < m; i++) pts[i] = {rhs[i], 2.0 - i, 0.5 * i * i};
        std::vector<NL_CPOINT> sol(n);
        N_SingleValueDecomposeSolve(A.p(), W.data(), V.p(), m - 1, n - 1, pts.data(), NL_EPOINT, NL_YES, sol.data());
        for (int j = 0; j < n; j++)
            put("svdsolve.nl." + tag + ".point." + std::to_string(j), {sol[j].x, sol[j].y, sol[j].z, sol[j].w});

        // the same through SmMatrix
        SmMatrix S(m, n), SV(n, n);
        for (int i = 0; i < m * n; i++) S.SetAt(i / n, i % n, c[2 + i]);
        SmTArray<double> SW;
        put("svd.sm." + tag + ".status", {double(S.SVDecompose(SW, SV))});
        std::vector<double> sw(SW.GetSize());
        for (size_t i = 0; i < sw.size(); i++) sw[i] = SW[ULONG(i)];
        std::sort(sw.rbegin(), sw.rend());
        put("svd.sm." + tag + ".w", sw);
        SmTArray<double> b, sx;
        b.SetSize(m);
        sx.SetSize(m);
        for (int i = 0; i < m; i++) b[i] = rhs[i];
        put("svdsolve.sm." + tag + ".status", {double(S.SolveWithSVDMatrices(b, SW, SV, sx))});
        std::vector<double> xs(m);
        for (int i = 0; i < m; i++) xs[i] = sx[i];
        put("svdsolve.sm." + tag + ".x", xs);
    }
    // where small singular values stop counting
    for (double ratio : {5e-8, 9e-8, 3e-7}) {
        Rows A(3, 3), V(3, 3);
        A.p()[0][0] = 2;
        A.p()[1][1] = 2 * ratio;
        A.p()[2][2] = 1;
        std::vector<double> W(3), r{1, 1, 1}, x(3);
        N_RealMatrixSingleValueDecompose(A.p(), W.data(), V.p(), 2, 2);
        N_SingleValueDecomposeSolve(A.p(), W.data(), V.p(), 2, 2, r.data(), NL_RVALUE, NL_YES, x.data());
        put("svdsolve.nl.limit." + std::to_string(ratio), x);
        for (double tol : {6e-8, 1e-6})
            for (int adjust : {0, 1}) {
                SmMatrix S(3, 3), SV(3, 3);
                S.Clear();
                S.SetAt(0, 0, 2);
                S.SetAt(1, 1, 2 * ratio);
                S.SetAt(2, 2, 1);
                SmTArray<double> SW, b, sx;
                S.SVDecompose(SW, SV);
                b.SetSize(3);
                sx.SetSize(3);
                b[0] = b[1] = b[2] = 1;
                int st = S.SolveWithSVDMatrices(b, SW, SV, sx, tol, adjust ? TRUE : FALSE);
                put("svdsolve.sm.limit." + std::to_string(ratio) + "." + std::to_string(tol) + "." + std::to_string(adjust),
                    {double(st), sx[0], sx[1], sx[2]});
            }
    }
    // wrong sizes and shapes
    {
        Rows A(2, 3), V(3, 3);
        std::vector<double> W(3);
        put("svd.nl.wide.flag", {double(N_RealMatrixSingleValueDecompose(A.p(), W.data(), V.p(), 1, 2))});
        SmMatrix S(2, 3), SV(3, 3);
        S.Clear();
        SmTArray<double> SW;
        put("svd.sm.wide.status", {double(S.SVDecompose(SW, SV))});
    }
}

void eigen_cases()
{
    std::vector<std::vector<double>> all{{3, 4, 1, 2, 1, 3, 0.5, 2, 0.5, 5},
                                         {4, 2, -1, 0, 0, -1, 2, -1, 0, 0, -1, 2, -1, 0, 0, -1, 2},
                                         {3, 1, 0, 0, 0, 7, 0, 0, 0, 3}};
    for (size_t k = 0; k < all.size(); k++) {
        const auto& c = all[k];
        int n = int(c[0]);
        SmMatrix S(n, n), E(n, n);
        for (int i = 0; i < n * n; i++) S.SetAt(i / n, i % n, c[1 + i]);
        SmTArray<double> e;
        ULONG it = 0;
        std::string tag = "eigen." + std::to_string(k);
        put(tag + ".status", {double(S.EigenSystemJacobiSolver(e, E, it))});
        std::vector<double> vals(n);
        for (int i = 0; i < n; i++) vals[i] = e[i];
        put(tag + ".values", vals);
        for (int j = 0; j < n; j++) {
            std::vector<double> col(n);
            for (int i = 0; i < n; i++) col[i] = E[i][j];
            put(tag + ".vector." + std::to_string(j), signless(col));
        }
        double restored = 0;
        for (int i = 0; i < n * n; i++) restored = std::max(restored, std::fabs(S.GetAt(i / n, i % n) - c[1 + i]));
        put("check." + tag + ".restored", {restored});
    }
    SmMatrix N(2, 2), E(2, 2);
    N.SetAt(0, 0, 1);
    N.SetAt(0, 1, 2);
    N.SetAt(1, 0, 3);
    N.SetAt(1, 1, 4);
    SmTArray<double> e;
    ULONG it = 0;
    put("eigen.nonsymmetric.status", {double(N.EigenSystemJacobiSolver(e, E, it))});
    // the 3x3 path the kernel itself uses
    SmMatrix T(3, 3);
    double t[9] = {4, 1, 2, 1, 3, 0.5, 2, 0.5, 5};
    for (int i = 0; i < 9; i++) T.SetAt(i / 3, i % 3, t[i]);
    ULONG count = 0;
    double ev[3];
    SmVector3d vecs[3];
    put("eigen3x3.status", {double(T.Compute3x3EigenVectors(count, ev, vecs))});
    put("eigen3x3.values", {ev[0], ev[1], ev[2]});
    for (int j = 0; j < 3; j++) put("eigen3x3.vector." + std::to_string(j), signless({vecs[j].x, vecs[j].y, vecs[j].z}));
}

double residual_tri(const double* a, const double* b, const double* c, double alpha, double beta, bool corner,
                    const std::vector<NL_POINT>& Q, const std::vector<NL_POINT>& P)
{
    int n = int(Q.size());
    double worst = 0;
    for (int k = 0; k < 3; k++) {
        auto g = [&](const NL_POINT& p) { return k == 0 ? p.x : k == 1 ? p.y : p.z; };
        for (int i = 0; i < n; i++) {
            double r = b[i] * g(P[i]) - g(Q[i]);
            if (i > 0) r += a[i] * g(P[i - 1]);
            if (i < n - 1) r += c[i] * g(P[i + 1]);
            if (corner && i == 0) r += beta * g(P[n - 1]);
            if (corner && i == n - 1) r += alpha * g(P[0]);
            worst = std::max(worst, std::fabs(r));
        }
    }
    return worst;
}

void tridiagonal_cases()
{
    const int n = 6;
    double a[n] = {0, 1, 2, 3, 1.5, 2.5}, b[n] = {10, 11, 12, 13, 14, 15}, c[n] = {4, 5, 6, 2, 0.9, 0};
    std::vector<NL_POINT> Q(n), P(n);
    for (int i = 0; i < n; i++) Q[i] = {1.0 + i, 0.5 * i * i, 2.0 - i};
    for (int m : {1, 2, n}) {
        std::vector<NL_POINT> q(Q.begin(), Q.begin() + m), p(m);
        int flag = M_TridiagonalSystem(a, b, c, q.data(), m, p.data());
        std::vector<double> flat{double(flag)};
        for (auto& x : p) flat.insert(flat.end(), {x.x, x.y, x.z});
        put("tridiagonal." + std::to_string(m), flat);
        put("check.tridiagonal." + std::to_string(m) + ".residual", {residual_tri(a, b, c, 0, 0, false, q, p)});
    }
    double zero[n] = {0, 11, 12, 13, 14, 15};
    put("tridiagonal.zero-pivot.flag", {double(M_TridiagonalSystem(a, zero, c, Q.data(), n, P.data()))});
    for (int m : {3, 4, n}) {
        std::vector<NL_POINT> q(Q.begin(), Q.begin() + m), p(m);
        int flag = M_CorneredTridiagonalSystem(a, b, c, 0.5, 0.25, q.data(), m, p.data());
        std::vector<double> flat{double(flag)};
        for (auto& x : p) flat.insert(flat.end(), {x.x, x.y, x.z});
        put("cornered." + std::to_string(m), flat);
        put("check.cornered." + std::to_string(m) + ".residual", {residual_tri(a, b, c, 0.5, 0.25, true, q, p)});
    }
    put("cornered.2.flag", {double(M_CorneredTridiagonalSystem(a, b, c, 0.5, 0.25, Q.data(), 2, P.data()))});
}

double g_shift = 0.3;
double bowl(double x) { return (x - g_shift) * (x - g_shift) + 2.0; }
double wave(double x) { return std::cos(x); }
double quartic(double x) { return std::pow(x - 1.25, 4) + 0.1 * x; }

void minimum_cases()
{
    double x = 0, f = 0;
    N_FuncFindMinima(0.0, 0.5, 2.0, bowl(0.5), bowl, 3e-8, 0.0, &x, &f);
    put("minimum.bowl", {x, f});
    N_FuncFindMinima(2.0, 3.0, 4.0, wave(3.0), wave, 3e-8, -2.0, &x, &f);
    put("minimum.wave", {x, f});
    N_FuncFindMinima(2.0, 3.0, 4.0, wave(3.0), wave, 3e-8, 0.0, &x, &f);
    put("minimum.wave.ftol", {x, f});
    N_FuncFindMinima(0.0, 1.0, 3.0, quartic(1.0), quartic, 1e-6, -1.0, &x, &f);
    put("minimum.quartic", {x, f});
}

void quadratic_cases()
{
    double cs[][3] = {{1, -3, 2}, {1, 2, 1}, {1, 0, 1}, {0, 2, -4}, {0, 0, 1}, {0, 0, 0}, {1e-9, 1, -1}, {1e-13, 1, -1},
                      {1e-12, 1, -1}, {1, -2, 1 + 1e-10}, {1, -2, 1 - 1e-10}, {1, -2, 1 + 2e-9}, {1, -2, 1 + 3e-9},
                      {1, -2, 1 - 2.4e-9}, {1, -2, 1 - 2.6e-9}, {1e4, -2e4, 1e4 * (1 + 1e-10)}, {2, 4, -6}, {-1, 0, 4},
                      {1, 1e8, 1}, {3, 0, 0}, {1e-8, 1, 1}};
    int k = 0;
    for (auto& q : cs) {
        double r1 = 0, r2 = 0;
        NL_INTEGER n = 0;
        int flag = N_SolveQuadraticEq(q[0], q[1], q[2], &r1, &r2, &n);
        std::vector<double> v{double(flag), double(n)};
        if (n > 0) v.insert(v.end(), {r1, r2});
        put("quadratic." + std::to_string(k++), v);
    }
}

void fit_cases()
{
    std::vector<NL_POINT> P;
    Lcg g{11};
    for (int i = 0; i < 12; i++) {
        double u = g.next() * 5, v = g.next() * 5;
        P.push_back({u, v, 0.3 * u - 0.2 * v + 1.5 + 1e-3 * g.next()});
    }
    double a = 0, b = 0, c = 0, d = 0;
    put("plane.flag", {double(N_FitPlanePts(P.data(), NL_INDEX(P.size() - 1), &a, &b, &c, &d))});
    std::vector<double> plane = signless({a, b, c});
    double s = plane[0] * a + plane[1] * b + plane[2] * c > 0 ? 1.0 : -1.0;
    plane.push_back(s * d);
    put("plane", plane);
    std::vector<NL_POINT> L;
    for (int i = 0; i < 10; i++) {
        double t = i * 0.7 - 2;
        L.push_back({1 + 2 * t + 1e-3 * g.next(), -1 + 0.5 * t + 1e-3 * g.next(), 3 - t + 1e-3 * g.next()});
    }
    NL_POINT q;
    NL_VECTOR v;
    put("line.flag", {double(N_LineFit3dPts(L.data(), NL_INDEX(L.size() - 1), &q, &v))});
    put("line.direction", signless({v.x, v.y, v.z}));
    // the point on the line nearest the origin, which does not depend on where along it the fit put q
    double len = std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z), dot = (q.x * v.x + q.y * v.y + q.z * v.z) / (len * len);
    put("line.nearest", {q.x - dot * v.x, q.y - dot * v.y, q.z - dot * v.z});
    Rows R(3, 3), RI(3, 3);
    double r[9] = {4, 1, 2, 1, 3, 0.5, 2, 0.5, 5};
    for (int i = 0; i < 9; i++) R.p()[i / 3][i % 3] = r[i];
    int flag = N_Real2dArrayInverseSVD(R.p(), 2, RI.p());
    put("inverse", {double(flag), RI.p()[0][0], RI.p()[0][1], RI.p()[0][2], RI.p()[1][0], RI.p()[1][1], RI.p()[1][2],
                    RI.p()[2][0], RI.p()[2][1], RI.p()[2][2]});
}

// a box and a cylinder through a transform with a reflection, the way a mirror would go
void transform_cases()
{
    double mirror[4][4] = {{-1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {10, 0, 0, 1}};
    double skewed[4][4] = {{1, 0.2, 0, 0}, {0, -1, 0, 0}, {0, 0, 2, 0}, {0, 0, 0, 1}};
    int k = 0;
    for (auto* m : {mirror, skewed}) {
        for (int shape = 0; shape < 2; shape++) {
            SmBrep* b = nullptr;
            if (shape == 0) SmApiCreateBox(SmVector3d(1, 2, 3), 4, 5, 6, b);
            else SmApiCreateCylinder(SmVector3d(0, 0, 0), 2, 5, b);
            std::string tag = "transform." + std::to_string(k) + "." + std::to_string(shape);
            int st = b ? int(b->Transform(m, TRUE)) : -1;
            SmBoolean man = FALSE;
            double vol = 0;
            SmPoint3d lo, hi;
            if (b) {
                SmApiBrepIsManifoldSolid(b, man);
                SmApiBrepComputeVolume(b, 1e-6, vol);
                SmApiBrepBoundingBox(b, TRUE, lo, hi);
            }
            put(tag, {double(st), double(man), std::fabs(vol), lo.x, lo.y, lo.z, hi.x, hi.y, hi.z});
            delete b;
        }
        k++;
    }
}

} // namespace

extern "C" char* sx_brep_routine_probe()
{
    SmApiGetOrCreateContext();
    out = Value::object();
    svd_cases();
    eigen_cases();
    tridiagonal_cases();
    minimum_cases();
    quadratic_cases();
    fit_cases();
    transform_cases();
    std::string s = sxj::dump(out);
    char* text = static_cast<char*>(std::malloc(s.size() + 1));
    if (text) std::memcpy(text, s.c_str(), s.size() + 1);
    return text;
}
