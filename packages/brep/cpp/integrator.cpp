// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Our version of the kernel's SmIntegrator.cpp, whose routines cite Numerical Recipes; swap-routines.sh removes
// that file and this one defines the classes SmIntegrator.h declares, written from the published algorithms:
//   quadrature       the extended trapezoid rule refined by halving, with Romberg's Richardson extrapolation or
//                    Simpson's rule on top (Stoer and Bulirsch, Introduction to Numerical Analysis); interval
//                    halving when a piece does not converge
//   interpolation    Neville's algorithm
//   ODE steps        classical fourth order Runge-Kutta, the embedded pair of Cash and Karp (ACM TOMS 16, 1990),
//                    Gragg's modified midpoint rule
//   step control     Hairer, Norsett and Wanner, Solving Ordinary Differential Equations I, II.4 and II.9: the
//                    step scales by 0.9 (1/err)^(1/5) within [0.2, 5]; the extrapolation (Bulirsch-Stoer) step
//                    uses the even sequence 2, 4, 6, ... and polynomial extrapolation in h^2
// As in the kernel, the ODE arrays run from 1 to n (entry 0 unused), except ystart and the optional scale of
// RungeKuttaODEIntegrate, which run from 0.
#include "StdAfx.h"

#include <SmIntegrator.h>

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <initializer_list>
#include <utility>
#include <vector>

namespace {

const int kMaxStages = 16;  // trapezoid refinements, 2^15 + 1 evaluations
const ULONG kMaxSplits = 4; // interval halvings in IntegrateIt

// The trapezoid sum on [a, b] (s) and the same for |f| (mag). Stage 1 takes the ends; each later stage adds the
// midpoints of the previous one.
struct Trapezoid {
    double s = 0, mag = 0;
    SmStatus refine(const SmIntegFuncEvalObj& f, double a, double b, ULONG stage)
    {
        if (stage <= 1) {
            double fa, fb;
            SER(f.Evaluate(a, fa));
            SER(f.Evaluate(b, fb));
            s = 0.5 * (b - a) * (fa + fb);
            mag = 0.5 * std::fabs(b - a) * (std::fabs(fa) + std::fabs(fb));
            return SM_SUCCESS;
        }
        unsigned long count = 1ul << (stage - 2);
        double h = (b - a) / double(count), sum = 0, abs_sum = 0;
        for (unsigned long i = 0; i < count; i++) {
            double v;
            SER(f.Evaluate(a + (double(i) + 0.5) * h, v));
            sum += v;
            abs_sum += std::fabs(v);
        }
        s = 0.5 * (s + h * sum);
        mag = 0.5 * (mag + std::fabs(h) * abs_sum);
        return SM_SUCCESS;
    }
    // a change within eps of the value, or within rounding of the sum, as when the integral is zero
    bool settled(double change, double value, double eps) const
    {
        return std::fabs(change) <= eps * std::fabs(value) + 64 * DBL_EPSILON * mag;
    }
};

// Romberg on [a, b]: row k of the tableau extrapolates the trapezoid sums to h = 0 with error terms h^2 ... h^2k
SmStatus romberg(const SmIntegFuncEvalObj& f, double a, double b, double eps, double& result, bool& converged)
{
    std::vector<double> prev, row;
    Trapezoid t;
    converged = false;
    for (int k = 0; k < kMaxStages; k++) {
        SER(t.refine(f, a, b, ULONG(k + 1)));
        row.assign(size_t(k) + 1, t.s);
        double scale = 4;
        for (int j = 1; j <= k; j++, scale *= 4) row[j] = row[j - 1] + (row[j - 1] - prev[j - 1]) / (scale - 1);
        result = row[k];
        if (k >= 3 && t.settled(row[k] - prev[k - 1], row[k], eps)) {
            converged = true;
            return SM_SUCCESS;
        }
        prev.swap(row);
    }
    return SM_SUCCESS;
}

SmStatus split(const SmIntegFuncEvalObj& f, double a, double b, double eps, ULONG level, double& result)
{
    bool converged;
    SER(romberg(f, a, b, eps, result, converged));
    if (converged) return SM_SUCCESS;
    if (level >= kMaxSplits) return SM_ERR;
    double m = 0.5 * (a + b), left, right;
    SER(split(f, a, m, eps, level + 1, left));
    SER(split(f, m, b, eps, level + 1, right));
    result = left + right;
    return SM_SUCCESS;
}

typedef SmTArray<double> Vec;

Vec sized(ULONG n)
{
    Vec v;
    v.SetSize(n + 1);
    for (ULONG i = 0; i <= n; i++) v[i] = 0;
    return v;
}

// y + h (c1 k1 + c2 k2 + ...) over entries 1..n
void combine(Vec& out, const Vec& y, double h, std::initializer_list<std::pair<double, const Vec*>> terms)
{
    ULONG n = y.GetSize() - 1;
    for (ULONG i = 1; i <= n; i++) {
        double sum = 0;
        for (auto& t : terms) sum += t.first * (*t.second)[i];
        out[i] = y[i] + h * sum;
    }
}

// the largest error relative to its scale; a scale of 0 counts only an error of 0
double scaled(const Vec& err, const Vec& scale)
{
    double worst = 0;
    ULONG n = err.GetSize() - 1;
    for (ULONG i = 1; i <= n; i++) {
        double e = std::fabs(err[i]);
        if (std::isnan(e)) return HUGE_VAL;
        if (e == 0) continue;
        worst = std::max(worst, scale[i] > 0 ? e / scale[i] : HUGE_VAL);
    }
    return worst;
}

} // namespace

SmStatus SmIntegrator::IntegrateIt(double dA, double dB, SmIntegratorAlgorithmType eIntegAlgorithm,
                                   double dDesiredAccuracy, double& rdResult)
{
    // like the kernel's, this always uses Romberg
    m_dA = dA;
    m_dB = dB;
    m_eIntegAlgorithm = eIntegAlgorithm;
    m_dDesiredAccuracy = dDesiredAccuracy;
    m_dRecursionLevel = 0;
    rdResult = 0;
    if (dA == dB) return SM_SUCCESS;
    return split(m_crFunctionEvaluator, dA, dB, dDesiredAccuracy, 0, rdResult);
}

// Neville's algorithm on the points dXA[1..lN], dYA[1..lN]. rdDY, an estimate of the error, is the change the
// farthest point makes: the value minus that of the interpolant through the other points.
SmStatus SmIntegrator::PolynomialInterpolation(double* dXA, double* dYA, ULONG lN, double dX, double& rdY,
                                               double& rdDY)
{
    if (lN < 1) return SM_ERR;
    std::vector<ULONG> order(lN);
    for (ULONG i = 0; i < lN; i++) order[i] = i + 1;
    std::stable_sort(order.begin(), order.end(),
                     [&](ULONG a, ULONG b) { return std::fabs(dX - dXA[a]) < std::fabs(dX - dXA[b]); });
    // the interpolant through the m points nearest dX
    auto neville = [&](ULONG m, double& v) {
        std::vector<double> p(m);
        for (ULONG i = 0; i < m; i++) p[i] = dYA[order[i]];
        for (ULONG k = 1; k < m; k++)
            for (ULONG i = 0; i + k < m; i++) {
                double xi = dXA[order[i]], xj = dXA[order[i + k]];
                if (xi == xj) return false;
                p[i] = ((dX - xj) * p[i] + (xi - dX) * p[i + 1]) / (xi - xj);
            }
        v = p[0];
        return true;
    };
    double all, fewer = 0;
    if (!neville(lN, all)) return SM_ERR;
    if (lN > 1) neville(lN - 1, fewer);
    rdY = all;
    rdDY = lN > 1 ? all - fewer : 0;
    return SM_SUCCESS;
}

SmStatus SmIntegrator::Trapazoid(double dA, double dB, ULONG lN, double& rdResult)
{
    Trapezoid t;
    t.s = lN <= 1 ? 0 : m_dS;
    SER(t.refine(m_crFunctionEvaluator, dA, dB, lN));
    rdResult = m_dS = t.s;
    return SM_SUCCESS;
}

SmStatus SmIntegrator::QRomberg(double& rdResult)
{
    bool converged;
    SER(romberg(m_crFunctionEvaluator, m_dA, m_dB, m_dDesiredAccuracy, rdResult, converged));
    return converged ? SM_SUCCESS : SM_ERR;
}

// Simpson's rule from two trapezoid stages, S = (4 T(h/2) - T(h)) / 3
SmStatus SmIntegrator::QSimpsons(double& rdResult)
{
    Trapezoid t;
    double last_t = 0, last_s = 0;
    for (int k = 0; k < kMaxStages; k++) {
        SER(t.refine(m_crFunctionEvaluator, m_dA, m_dB, ULONG(k + 1)));
        if (k > 0) {
            double s = (4 * t.s - last_t) / 3;
            if (k >= 4 && t.settled(s - last_s, s, m_dDesiredAccuracy)) {
                rdResult = s;
                return SM_SUCCESS;
            }
            last_s = s;
        }
        last_t = t.s;
    }
    rdResult = last_s;
    return SM_ERR;
}

SmODEIntegrator::SmODEIntegrator(const SmODEIntegFuncEvalObj& crFunctionEvaluator, ULONG lMaxStep, double dTiny)
    : m_lRecursionDepth(0), m_lMaxStep(lMaxStep), m_dTiny(dTiny), m_crFunctionEvaluator(crFunctionEvaluator),
      first(1), kmax(0), kopt(0), epsold(-1), xnew(0)
{
    for (double& v : a) v = 0;
    for (auto& row : alf)
        for (double& v : row) v = 0;
}

// one classical fourth order step of length h from x
SmStatus SmODEIntegrator::RungeKuttaAdvance(SmTArray<double>& y, SmTArray<double>& dydx, double x, double h,
                                            SmTArray<double>& yout)
{
    ULONG n = y.GetSize() - 1;
    Vec t = sized(n), k2 = sized(n), k3 = sized(n), k4 = sized(n);
    combine(t, y, h / 2, {{1.0, &dydx}});
    SER(m_crFunctionEvaluator.Evaluate(x + h / 2, t, k2));
    combine(t, y, h / 2, {{1.0, &k2}});
    SER(m_crFunctionEvaluator.Evaluate(x + h / 2, t, k3));
    combine(t, y, h, {{1.0, &k3}});
    SER(m_crFunctionEvaluator.Evaluate(x + h, t, k4));
    if (yout.GetSize() < n + 1) yout.SetSize(n + 1);
    combine(yout, y, h / 6, {{1.0, &dydx}, {2.0, &k2}, {2.0, &k3}, {1.0, &k4}});
    return SM_SUCCESS;
}

// one fifth order step of at most htry, shrunk until its error estimate is within eps of yscal; hnext is the
// step to try next
SmStatus SmODEIntegrator::RungeKutta5thOrderStep(SmTArray<double>& y, SmTArray<double>& dydx, double& x, double htry,
                                                 double eps, SmTArray<double>& yscal, double& hdid, double& hnext)
{
    ULONG n = y.GetSize() - 1;
    Vec yout = sized(n), yerr = sized(n), scale = sized(n);
    for (ULONG i = 1; i <= n; i++) scale[i] = eps * yscal[i];
    double h = htry, err;
    bool rejected = false;
    for (;;) {
        SER(RungeKuttaCashKarpAdvance(y, dydx, x, h, yout, yerr));
        err = scaled(yerr, scale);
        if (err <= 1) break;
        rejected = true;
        h *= std::isfinite(err) ? std::max(0.2, 0.9 * std::pow(err, -0.2)) : 0.2;
        if (x + h == x) return SM_ERR;
    }
    double grow = err > 0 ? 0.9 * std::pow(err, -0.2) : 5.0;
    hnext = h * std::min(rejected ? 1.0 : 5.0, std::max(0.2, grow));
    hdid = h;
    x += h;
    for (ULONG i = 1; i <= n; i++) y[i] = yout[i];
    return SM_SUCCESS;
}

// the Cash-Karp pair: yout is the fifth order result, yerr its difference from the fourth order one
SmStatus SmODEIntegrator::RungeKuttaCashKarpAdvance(SmTArray<double>& y, SmTArray<double>& dydx, double x, double h,
                                                    SmTArray<double>& yout, SmTArray<double>& yerr)
{
    ULONG n = y.GetSize() - 1;
    Vec t = sized(n), k2 = sized(n), k3 = sized(n), k4 = sized(n), k5 = sized(n), k6 = sized(n);
    const Vec& k1 = dydx;
    combine(t, y, h, {{1.0 / 5, &k1}});
    SER(m_crFunctionEvaluator.Evaluate(x + h / 5, t, k2));
    combine(t, y, h, {{3.0 / 40, &k1}, {9.0 / 40, &k2}});
    SER(m_crFunctionEvaluator.Evaluate(x + 3 * h / 10, t, k3));
    combine(t, y, h, {{3.0 / 10, &k1}, {-9.0 / 10, &k2}, {6.0 / 5, &k3}});
    SER(m_crFunctionEvaluator.Evaluate(x + 3 * h / 5, t, k4));
    combine(t, y, h, {{-11.0 / 54, &k1}, {5.0 / 2, &k2}, {-70.0 / 27, &k3}, {35.0 / 27, &k4}});
    SER(m_crFunctionEvaluator.Evaluate(x + h, t, k5));
    combine(t, y, h,
            {{1631.0 / 55296, &k1}, {175.0 / 512, &k2}, {575.0 / 13824, &k3}, {44275.0 / 110592, &k4},
             {253.0 / 4096, &k5}});
    SER(m_crFunctionEvaluator.Evaluate(x + 7 * h / 8, t, k6));
    if (yout.GetSize() < n + 1) yout.SetSize(n + 1);
    if (yerr.GetSize() < n + 1) yerr.SetSize(n + 1);
    // fifth order weights, and their differences from the fourth order ones
    const double b1 = 37.0 / 378, b3 = 250.0 / 621, b4 = 125.0 / 594, b6 = 512.0 / 1771;
    const double e1 = b1 - 2825.0 / 27648, e3 = b3 - 18575.0 / 48384, e4 = b4 - 13525.0 / 55296,
                 e5 = -277.0 / 14336, e6 = b6 - 1.0 / 4;
    Vec zero = sized(n);
    combine(yerr, zero, h, {{e1, &k1}, {e3, &k3}, {e4, &k4}, {e5, &k5}, {e6, &k6}});
    combine(yout, y, h, {{b1, &k1}, {b3, &k3}, {b4, &k4}, {b6, &k6}});
    return SM_SUCCESS;
}

// Integrates from x1 to x2, starting from ystart[0..n-1], with adaptive Cash-Karp steps. The error of each step
// is held within eps times pOptYScale, or by default eps times the larger of |y| and |y + h y'|.
SmStatus SmODEIntegrator::RungeKuttaODEIntegrate(SmTArray<double>& ystart, double x1, double x2, double eps, double h1,
                                                 double hmin, ULONG& nok, ULONG& nbad, SmTArray<double>* pOptYScale)
{
    nok = nbad = 0;
    if (x1 == x2) return SM_SUCCESS;
    ULONG n = ystart.GetSize();
    if (pOptYScale && pOptYScale->GetSize() < n) return SM_ERR_INVALID_INPUT;
    Vec y = sized(n), dydx = sized(n), yscal = sized(n);
    for (ULONG i = 1; i <= n; i++) y[i] = ystart[i - 1];
    double dir = x2 > x1 ? 1.0 : -1.0, x = x1;
    double h = h1 != 0 ? dir * std::fabs(h1) : x2 - x1;
    for (ULONG step = 0; step < m_lMaxStep; step++) {
        SER(m_crFunctionEvaluator.Evaluate(x, y, dydx));
        for (ULONG i = 1; i <= n; i++)
            yscal[i] = pOptYScale ? (*pOptYScale)[i - 1]
                                  : std::max(std::fabs(y[i]), std::fabs(y[i] + h * dydx[i])) + m_dTiny;
        bool last = (x + h - x2) * dir >= 0;
        if (last) h = x2 - x;
        double hdid, hnext;
        SER(RungeKutta5thOrderStep(y, dydx, x, h, eps, yscal, hdid, hnext));
        if (hdid == h) nok++;
        else nbad++;
        if (last && hdid == h) {
            for (ULONG i = 1; i <= n; i++) ystart[i - 1] = y[i];
            return SM_SUCCESS;
        }
        if (std::fabs(hnext) < hmin) return SM_ERR;
        h = hnext;
    }
    return SM_ERR;
}

// Gragg's modified midpoint rule: nstep substeps of htot / nstep from xs, with the final smoothing step
SmStatus SmODEIntegrator::ModifiedMidpointStep(SmTArray<double>& y, SmTArray<double>& dydx, double xs, double htot,
                                               ULONG nstep, SmTArray<double>& yout)
{
    if (nstep < 1) return SM_ERR;
    ULONG n = y.GetSize() - 1;
    double h = htot / double(nstep);
    Vec prev = sized(n), cur = sized(n), f = sized(n), next = sized(n);
    for (ULONG i = 1; i <= n; i++) prev[i] = y[i];
    combine(cur, y, h, {{1.0, &dydx}});
    for (ULONG m = 1; m < nstep; m++) {
        SER(m_crFunctionEvaluator.Evaluate(xs + double(m) * h, cur, f));
        combine(next, prev, 2 * h, {{1.0, &f}});
        std::swap(prev, cur);
        std::swap(cur, next);
    }
    SER(m_crFunctionEvaluator.Evaluate(xs + htot, cur, f));
    if (yout.GetSize() < n + 1) yout.SetSize(n + 1);
    for (ULONG i = 1; i <= n; i++) yout[i] = 0.5 * (prev[i] + cur[i] + h * f[i]);
    return SM_SUCCESS;
}

// Estimate iest (1, 2, ...) of the values at 0, taken at xext, joins the tableau (iest 1 starts a new one); yz is
// the polynomial extrapolation to xext = 0 through all estimates so far and dy the change the last one made
SmStatus SmODEIntegrator::PolynomialExtrapolation(ULONG iest, double xext, SmTArray<double>& yest,
                                                  SmTArray<double>& yz, SmTArray<double>& dy)
{
    ULONG n = yest.GetSize() - 1;
    if (iest < 1 || iest > ULONG(SM_IMAXX)) return SM_ERR;
    if (xar.GetSize() < ULONG(SM_IMAXX) + 1) xar.SetSize(SM_IMAXX + 1);
    // ddata holds the last row of the tableau, SM_IMAXX + 1 entries per value
    ULONG width = SM_IMAXX + 1;
    if (ddata.GetSize() < (n + 1) * width) ddata.SetSize((n + 1) * width);
    xar[iest] = xext;
    if (yz.GetSize() < n + 1) yz.SetSize(n + 1);
    if (dy.GetSize() < n + 1) dy.SetSize(n + 1);
    for (ULONG i = 1; i <= n; i++) {
        double* row = &ddata[i * width];
        double t = yest[i], change = 0;
        // row[j] was T(iest - 1, j); T(iest, j) = T(iest, j - 1) + (T(iest, j - 1) - T(iest - 1, j - 1)) / (x ratio - 1)
        for (ULONG j = 1; j < iest; j++) {
            double ratio = xar[iest - j] / xext;
            if (ratio == 1) return SM_ERR;
            double prev = row[j - 1];
            row[j - 1] = t;
            change = (t - prev) / (ratio - 1);
            t += change;
        }
        row[iest - 1] = t;
        yz[i] = t;
        dy[i] = iest > 1 ? change : t;
    }
    return SM_SUCCESS;
}

// One extrapolation step of at most htry: modified midpoint with 2, 4, 6, ... substeps, extrapolated to zero
// step size until the change is within eps of yscal; a step that does not converge is shrunk and retried
SmStatus SmODEIntegrator::BulirschStoerStep(SmTArray<double>& y, SmTArray<double>& dydx, double& x, double htry,
                                            double eps, SmTArray<double>& yscal, double& hdid, double& hnext)
{
    ULONG n = y.GetSize() - 1;
    Vec mid = sized(n), yz = sized(n), dy = sized(n), scale = sized(n);
    for (ULONG i = 1; i <= n; i++) scale[i] = eps * yscal[i];
    double h = htry;
    for (;;) {
        double err = HUGE_VAL;
        for (ULONG k = 1; k <= ULONG(SM_KMAXX); k++) {
            ULONG steps = 2 * k;
            SER(ModifiedMidpointStep(y, dydx, x, h, steps, mid));
            double sub = h / double(steps);
            SER(PolynomialExtrapolation(k, sub * sub, mid, yz, dy));
            if (k < 2) continue;
            err = scaled(dy, scale);
            if (err <= 1) {
                // order 2k - 1 error estimate, kept between a fifth and four times this step
                double f = err > 0 ? 0.94 * std::pow(0.65 / err, 1.0 / double(2 * k - 1)) : 4.0;
                hnext = h * std::min(4.0, std::max(0.2, f));
                hdid = h;
                x += h;
                for (ULONG i = 1; i <= n; i++) y[i] = yz[i];
                return SM_SUCCESS;
            }
        }
        double f = std::isfinite(err) ? 0.94 * std::pow(0.65 / err, 1.0 / double(2 * SM_KMAXX - 1)) : 0.1;
        h *= std::min(0.7, std::max(0.1, f));
        if (x + h == x) return SM_ERR;
    }
}
