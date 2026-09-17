"""Independent Monte Carlo control for the seed-sensitive SciCode #46 tests.

Append to scicode-helium.py. Complementing a uniform draw preserves the
acceptance probability, but the upstream frozen trajectory accepts only one
of these equivalent implementations. Never supplied to model trials.
"""
COMPLEMENT_DRAW = False


def metropolis(configs, wf, tau, nsteps):
    poscur = np.array(configs, dtype=float, copy=True)
    for _ in range(nsteps):
        posnew = poscur + np.sqrt(tau) * np.random.randn(*poscur.shape)
        ratio = (wf.value(posnew) / wf.value(poscur)) ** 2
        u = np.random.rand(len(poscur))
        if COMPLEMENT_DRAW:
            u = 1.0 - u
        accept = u < np.minimum(ratio, 1.0)
        poscur[accept] = posnew[accept]
    return poscur


def calc_energy(configs, nsteps, tau, alpha, Z):
    wf, hamiltonian = Slater(alpha), Hamiltonian(Z)
    positions = metropolis(configs, wf, tau, nsteps)
    values = [wf.kinetic(positions), hamiltonian.potential_electron_ion(positions),
              hamiltonian.potential_electron_electron(positions)]
    return ([float(np.mean(v)) for v in values],
            [float(np.std(v) / np.sqrt(len(positions))) for v in values])
