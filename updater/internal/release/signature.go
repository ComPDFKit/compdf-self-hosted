package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const maxSignatureBytes = 64 * 1024

type Signature struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Algorithm      string `json:"algorithm"`
	KeyID          string `json:"keyId"`
	ManifestSHA256 string `json:"manifestSha256"`
	Value          string `json:"signature"`
}

func ParseSignature(data []byte) (Signature, error) {
	if len(data) == 0 || len(data) > maxSignatureBytes {
		return Signature{}, errors.New("release signature is empty or too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var signature Signature
	if err := decoder.Decode(&signature); err != nil {
		return Signature{}, fmt.Errorf("decode release signature: %w", err)
	}
	var trailing unknownJSON
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Signature{}, errors.New("release signature contains trailing data")
	}
	if signature.SchemaVersion != 1 || signature.Algorithm != "Ed25519" || signature.KeyID == "" {
		return Signature{}, errors.New("release signature metadata is invalid")
	}
	if _, err := hex.DecodeString(signature.ManifestSHA256); err != nil || len(signature.ManifestSHA256) != sha256.Size*2 {
		return Signature{}, errors.New("release signature manifestSha256 is invalid")
	}
	return signature, nil
}

func VerifySignature(manifestBytes []byte, signature Signature, trustedKeys map[string]ed25519.PublicKey) error {
	digest := sha256.Sum256(manifestBytes)
	if hex.EncodeToString(digest[:]) != signature.ManifestSHA256 {
		return errors.New("release manifest checksum does not match signature metadata")
	}
	publicKey, ok := trustedKeys[signature.KeyID]
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("release signing key %q is not trusted", signature.KeyID)
	}
	value, err := base64.StdEncoding.DecodeString(signature.Value)
	if err != nil || len(value) != ed25519.SignatureSize {
		return errors.New("release signature value is invalid")
	}
	if !ed25519.Verify(publicKey, manifestBytes, value) {
		return errors.New("release manifest signature verification failed")
	}
	return nil
}
