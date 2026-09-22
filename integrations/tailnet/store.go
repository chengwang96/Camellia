package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"

	"tailscale.com/ipn"
)

type encryptedStore struct {
	directory string
	aead      cipher.AEAD
}

func newStore(directory string, key []byte) (*encryptedStore, error) {
	if len(key) != 32 {
		return nil, errors.New("invalid storage key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	return &encryptedStore{directory: directory, aead: aead}, nil
}

func (store *encryptedStore) filename(key ipn.StateKey) string {
	digest := sha256.Sum256([]byte(key))
	return filepath.Join(store.directory, hex.EncodeToString(digest[:])+".state")
}

func (store *encryptedStore) ReadState(key ipn.StateKey) ([]byte, error) {
	data, err := os.ReadFile(store.filename(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ipn.ErrStateNotExist
	}
	if err != nil {
		return nil, err
	}
	if len(data) < store.aead.NonceSize() {
		return nil, errors.New("invalid encrypted state")
	}
	return store.aead.Open(nil, data[:store.aead.NonceSize()], data[store.aead.NonceSize():], []byte(key))
}

func (store *encryptedStore) WriteState(key ipn.StateKey, value []byte) error {
	nonce := make([]byte, store.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	data := store.aead.Seal(nonce, nonce, value, []byte(key))
	file, err := os.CreateTemp(store.directory, ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), store.filename(key))
}
