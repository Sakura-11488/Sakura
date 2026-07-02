type Props = {
  visible: boolean;
  walletAddress: string;
  onClose: () => void;
  onPurchaseComplete?: () => void;
};

/** Native stub — web uses TransakWebModal.web.tsx */
export default function TransakWebModal(_props: Props) {
  return null;
}
