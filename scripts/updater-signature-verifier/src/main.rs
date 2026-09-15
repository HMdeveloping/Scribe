use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::Path};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: verifier <artifact> <clean-signature> <public-key>");
        std::process::exit(2);
    }

    let artifact = fs::read(&args[1]).expect("unable to read updater artifact");
    let signature_text = fs::read_to_string(&args[2]).expect("unable to read signature");
    let public_key_text = String::from_utf8(
        STANDARD
            .decode(args[3].trim())
            .expect("invalid public-key base64"),
    )
    .expect("public key is not UTF-8");
    let public_key = PublicKey::decode(&public_key_text).expect("invalid public key");
    let signature_text = String::from_utf8(
        STANDARD
            .decode(signature_text.trim())
            .expect("invalid signature base64"),
    )
    .expect("signature is not UTF-8");
    let signature = Signature::decode(&signature_text).expect("invalid Minisign signature");
    public_key
        .verify(&artifact, &signature, true)
        .expect("signature does not verify against updater artifact");
    println!(
        "Updater signature verified: {}",
        Path::new(&args[1]).display()
    );
}
