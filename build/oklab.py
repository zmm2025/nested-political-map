import numpy as np

M1 = np.array([[0.8189330101, 0.3618667424, -0.1288597137],
               [0.0329845436, 0.9293118715, 0.0361456387],
               [0.0482003018, 0.2643662691, 0.6338517070]])
M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
               [1.9779984951, -2.4285922050, 0.4505937099],
               [0.0259040371, 0.7827717662, -0.8086757660]])
XYZ = np.array([[0.4123907993, 0.3575843394, 0.1804807884],
                [0.2126390059, 0.7151686788, 0.0721923154],
                [0.0193308187, 0.1191947798, 0.9505321522]])
A = M1 @ XYZ                 # linear sRGB -> LMS
Ai, M2i = np.linalg.inv(A), np.linalg.inv(M2)


def lab2lin(x):
    return ((x @ M2i.T) ** 3) @ Ai.T


def lin2lab(r):
    return np.cbrt(r @ A.T) @ M2.T


def jac(x):
    """d linear-RGB / d OKLab, shape (..., 3, 3)."""
    lms = x @ M2i.T
    return np.einsum("ij,...j,jk->...ik", Ai, 3 * lms ** 2, M2i)


def enc(r):
    r = np.clip(r, 0, 1)
    return np.where(r <= 0.0031308, 12.92 * r, 1.055 * r ** (1 / 2.4) - 0.055)


def dec(s):
    return np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)


def lch(L, C, h):
    h = np.radians(h)
    return np.stack(np.broadcast_arrays(L, C * np.cos(h), C * np.sin(h)), -1).astype(float)


def to8(x):
    return np.round(enc(lab2lin(x)) * 255).astype(np.uint8)


def from8(c):
    return lin2lab(dec(c / 255.0))


# Machado et al. 2009, severity 1.0, applied in linear RGB
DEUTAN = np.array([[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]])
PROTAN = np.array([[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]])


def cvd(x, m):
    return lin2lab(np.clip(lab2lin(x) @ m.T, 0, 1))


def selftest():
    w = lin2lab(np.ones(3))
    assert np.allclose(w, [1, 0, 0], atol=1e-3), w
    x = lch(0.6, 0.1, 200)
    assert np.allclose(lin2lab(lab2lin(x)), x)


selftest()
