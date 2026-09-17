"""Analytic functions for the first two subproblems of official SciCode #46.

Regression fixture for heterogeneous tuple comparisons in the official tests.
"""
import numpy as np


class Slater:
    def __init__(self, alpha):
        self.alpha = alpha

    def value(self, configs):
        return np.exp(-self.alpha * np.linalg.norm(configs, axis=-1).sum(axis=-1))

    def gradient(self, configs):
        return -self.alpha * configs / np.linalg.norm(configs, axis=-1)[..., None]

    def laplacian(self, configs):
        return self.alpha**2 - 2 * self.alpha / np.linalg.norm(configs, axis=-1)

    def kinetic(self, configs):
        return -0.5 * self.laplacian(configs).sum(axis=-1)


class Hamiltonian:
    def __init__(self, Z):
        self.Z = Z

    def potential_electron_ion(self, configs):
        return -self.Z * (1 / np.linalg.norm(configs, axis=-1)).sum(axis=-1)

    def potential_electron_electron(self, configs):
        return 1 / np.linalg.norm(configs[:, 0] - configs[:, 1], axis=-1)

    def potential(self, configs):
        return self.potential_electron_ion(configs) + self.potential_electron_electron(configs)
